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

export class ProductResponseDto {
  id: number;
  name: string;
  description: string | null;
  price: number;
  categoryId: number;
  category: CategoryResponseDto | null;
  isActive: boolean;
  images: ProductImageResponseDto[];
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(product: ProductEntity): ProductResponseDto {
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
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }
}
