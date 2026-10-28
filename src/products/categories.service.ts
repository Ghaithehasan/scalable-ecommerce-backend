import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import {
  isForeignKeyViolation,
  isUniqueViolation,
} from '../common/database/postgres-errors';
import { CategoryResponseDto } from './dto/category-response.dto';
import { CreateCategoryDto } from './dto/create-category.dto';
import { QueryCategoriesDto } from './dto/query-categories.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CategoryEntity } from './entities/category.entity';

/** Builds a URL-safe slug from a category name. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(CategoryEntity)
    private readonly categoryRepository: Repository<CategoryEntity>,
  ) {}

  async findAll(
    query: QueryCategoriesDto,
  ): Promise<PaginatedResponseDto<CategoryResponseDto>> {
    const [categories, total] = await this.categoryRepository.findAndCount({
      where: query.isActive === undefined ? {} : { isActive: query.isActive },
      // `name` alone is not unique, so `id` breaks ties and keeps paging stable.
      order: { name: 'ASC', id: 'ASC' },
      skip: query.skip,
      take: query.limit,
    });

    return PaginatedResponseDto.of(
      categories.map((category) => CategoryResponseDto.fromEntity(category)),
      total,
      query.page,
      query.limit,
    );
  }

  async findByIdOrFail(id: number): Promise<CategoryEntity> {
    const category = await this.categoryRepository.findOneBy({ id });

    if (!category) {
      throw new NotFoundException(`Category with id ${id} not found`);
    }

    return category;
  }

  async create(dto: CreateCategoryDto): Promise<CategoryEntity> {
    const slug = dto.slug ?? slugify(dto.name);

    if (!slug) {
      throw new ConflictException(
        'A slug could not be derived from the name; supply "slug" explicitly',
      );
    }

    const category = this.categoryRepository.create({
      name: dto.name,
      slug,
      description: dto.description ?? null,
      isActive: dto.isActive ?? true,
    });

    return this.saveOrConflict(category);
  }

  async update(id: number, dto: UpdateCategoryDto): Promise<CategoryEntity> {
    const category = await this.findByIdOrFail(id);

    if (dto.name !== undefined) {
      category.name = dto.name;
    }

    if (dto.slug !== undefined) {
      category.slug = dto.slug;
    }

    if (dto.description !== undefined) {
      category.description = dto.description ?? null;
    }

    if (dto.isActive !== undefined) {
      category.isActive = dto.isActive;
    }

    return this.saveOrConflict(category);
  }

  async remove(id: number): Promise<void> {
    const category = await this.findByIdOrFail(id);

    try {
      await this.categoryRepository.remove(category);
    } catch (error) {
      // products.category_id is ON DELETE RESTRICT, so the database refuses to
      // orphan the products that are still classified under this category.
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(
          `Category with id ${id} still has products and cannot be deleted`,
        );
      }

      throw error;
    }
  }

  private async saveOrConflict(
    category: CategoryEntity,
  ): Promise<CategoryEntity> {
    try {
      return await this.categoryRepository.save(category);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `Category slug "${category.slug}" already exists`,
        );
      }

      throw error;
    }
  }
}
