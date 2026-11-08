import type { ProductEntity } from '../entities/product.entity';
import type { ProductImageEntity } from '../entities/product-image.entity';
import { CategoryResponseDto } from './category-response.dto';

export class ProductImageResponseDto {
  id: number;
  imageUrl: string;
  isPrimary: boolean;
  sortOrder: number;

  static fromEntity(image: ProductImageEntity): ProductImageResponseDto {
    return {
      id: image.id,
      imageUrl: image.imageUrl,
      isPrimary: image.isPrimary,
      sortOrder: image.sortOrder,
    };
  }
}

/**
 * Quantities owned by the inventory service, not by this application.
 *
 * `null` means the warehouse could not be reached. The catalogue still
 * renders - a product page without a stock figure is far better than an error
 * page - and the null is explicit so a client can say "unavailable" rather
 * than silently showing zero.
 */
export class ProductStockDto {
  available: number;
  reserved: number;
}

export class ProductResponseDto {
  id: number;
  name: string;
  description: string | null;
  price: number;
  categoryId: number;
  category: CategoryResponseDto | null;
  isActive: boolean;
  images: ProductImageResponseDto[];
  stock: ProductStockDto | null;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(
    product: ProductEntity,
    stock: ProductStockDto | null = null,
  ): ProductResponseDto {
    const images = product.images ?? [];

    return {
      id: product.id,
      name: product.name,
      description: product.description ?? null,
      price: product.price,
      categoryId: product.categoryId,
      category: product.category
        ? CategoryResponseDto.fromEntity(product.category)
        : null,
      isActive: product.isActive,
      images: [...images]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
        .map((image) => ProductImageResponseDto.fromEntity(image)),
      stock,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }
}
