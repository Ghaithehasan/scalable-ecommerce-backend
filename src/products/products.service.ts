import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  FindOptionsWhere,
  In,
  Repository,
} from 'typeorm';

import { isForeignKeyViolation } from '../common/database/postgres-errors';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { isPrivileged } from '../common/authorization/resource-ownership';
import type { UserResponseDto } from '../users/dto/user-response.dto';
import { CategoriesService } from './categories.service';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductImageDto } from './dto/product-image.dto';
import { ProductResponseDto } from './dto/product-response.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductEntity } from './entities/product.entity';
import { ProductImageEntity } from './entities/product-image.entity';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(ProductEntity)
    private readonly productRepository: Repository<ProductEntity>,
    private readonly categoriesService: CategoriesService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Returns one page of products.
   *
   * Both the category filter and the paging are applied by the database, so a
   * large catalogue is never loaded into memory to be filtered afterwards.
   */
  async findAll(
    query: QueryProductsDto,
    currentUser: UserResponseDto,
  ): Promise<PaginatedResponseDto<ProductResponseDto>> {
    const where: FindOptionsWhere<ProductEntity> = {};

    if (query.categoryId !== undefined) {
      // Fails loudly instead of returning an empty page for a category that
      // does not exist, so a client typo is visible immediately.
      await this.categoriesService.findByIdOrFail(query.categoryId);
      where.categoryId = query.categoryId;
    }

    // A customer only ever sees products that are on sale; a RESPONSIBLE user
    // manages the catalogue and may look at deactivated products too.
    where.isActive = isPrivileged(currentUser) ? query.isActive : true;

    if (where.isActive === undefined) {
      delete where.isActive;
    }

    const [products, total] = await this.productRepository.findAndCount({
      where,
      relations: { category: true, images: true },
      // `createdAt` can repeat within the same transaction, so `id` is the
      // tie-breaker that makes the page order deterministic.
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: query.skip,
      take: query.limit,
    });

    return PaginatedResponseDto.of(
      products.map((product) => ProductResponseDto.fromEntity(product)),
      total,
      query.page,
      query.limit,
    );
  }

  /**
   * Reads catalogue rows by id for another module (orders needs the current
   * price). `manager` lets the caller run the lookup inside its own
   * transaction so the price it reads is the price it stores.
   */
  findByIds(ids: number[], manager?: EntityManager): Promise<ProductEntity[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    const repository = manager
      ? manager.getRepository(ProductEntity)
      : this.productRepository;

    return repository.find({ where: { id: In(ids) } });
  }

  async findOneOrFail(
    id: number,
    currentUser: UserResponseDto,
  ): Promise<ProductEntity> {
    const product = await this.productRepository.findOne({
      where: { id },
      relations: { category: true, images: true },
    });

    // A deactivated product is reported as missing rather than forbidden: its
    // existence is not something a customer is entitled to learn.
    if (!product || (!product.isActive && !isPrivileged(currentUser))) {
      throw new NotFoundException(`Product with id ${id} not found`);
    }

    return product;
  }

  async create(dto: CreateProductDto): Promise<ProductEntity> {
    await this.categoriesService.findByIdOrFail(dto.categoryId);

    const product = this.productRepository.create({
      name: dto.name,
      description: dto.description ?? null,
      price: dto.price,
      categoryId: dto.categoryId,
      isActive: dto.isActive ?? true,
      images: this.buildImages(dto.images),
    });

    const saved = await this.productRepository.save(product);
    return this.reload(saved.id);
  }

  async update(id: number, dto: UpdateProductDto): Promise<ProductEntity> {
    const product = await this.productRepository.findOne({ where: { id } });

    if (!product) {
      throw new NotFoundException(`Product with id ${id} not found`);
    }

    if (dto.categoryId !== undefined) {
      await this.categoriesService.findByIdOrFail(dto.categoryId);
      product.categoryId = dto.categoryId;
    }

    if (dto.name !== undefined) {
      product.name = dto.name;
    }

    if (dto.description !== undefined) {
      product.description = dto.description ?? null;
    }

    if (dto.price !== undefined) {
      product.price = dto.price;
    }

    if (dto.isActive !== undefined) {
      product.isActive = dto.isActive;
    }

    const images =
      dto.images === undefined ? undefined : this.buildImages(dto.images);

    // Replacing an image set is two statements, so it runs in a transaction:
    // a product must never be left with the old images deleted and the new
    // ones missing.
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(ProductEntity).save(product);

      if (images === undefined) {
        return;
      }

      const imageRepository = manager.getRepository(ProductImageEntity);
      await imageRepository.delete({ productId: product.id });

      if (images.length > 0) {
        await imageRepository.save(
          images.map((image) =>
            imageRepository.create({ ...image, productId: product.id }),
          ),
        );
      }
    });

    return this.reload(product.id);
  }

  async remove(id: number): Promise<void> {
    const product = await this.productRepository.findOne({ where: { id } });

    if (!product) {
      throw new NotFoundException(`Product with id ${id} not found`);
    }

    try {
      await this.productRepository.remove(product);
    } catch (error) {
      // order_items.product_id is ON DELETE RESTRICT: deleting a product that
      // has been ordered would rewrite order history, so it is refused.
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(
          `Product with id ${id} belongs to an existing order and cannot be deleted; ` +
            'set "isActive" to false to withdraw it from sale',
        );
      }

      throw error;
    }
  }

  /**
   * Normalises an image set: exactly one image is primary and every image has
   * an explicit position.
   */
  private buildImages(images?: ProductImageDto[]): Partial<ProductImageEntity>[] {
    if (!images?.length) {
      return [];
    }

    const primaryCount = images.filter((image) => image.isPrimary).length;

    if (primaryCount > 1) {
      throw new BadRequestException(
        'Only one product image can be marked as primary',
      );
    }

    return images.map((image, index) => ({
      imageUrl: image.imageUrl,
      isPrimary: primaryCount === 0 ? index === 0 : image.isPrimary === true,
      sortOrder: image.sortOrder ?? index,
    }));
  }

  private async reload(id: number): Promise<ProductEntity> {
    const product = await this.productRepository.findOne({
      where: { id },
      relations: { category: true, images: true },
    });

    if (!product) {
      throw new NotFoundException(`Product with id ${id} not found`);
    }

    return product;
  }
}
