import type { OrderEntity } from '../entities/order.entity';
import type { OrderItemEntity } from '../entities/order-item.entity';
import type { OrderStatus } from '../enums/order-status.enum';

export class OrderItemResponseDto {
  id: number;
  productId: number;
  productName: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;

  static fromEntity(item: OrderItemEntity): OrderItemResponseDto {
    return {
      id: item.id,
      productId: item.productId,
      productName: item.product?.name ?? null,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal:
        Math.round(item.unitPrice * 100) * item.quantity / 100,
    };
  }
}

export class OrderResponseDto {
  id: number;
  orderNumber: string;
  userId: number;
  status: OrderStatus;
  totalAmount: number;
  items: OrderItemResponseDto[];
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(order: OrderEntity): OrderResponseDto {
    const items = order.items ?? [];

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      userId: order.userId,
      status: order.status,
      totalAmount: order.totalAmount,
      items: [...items]
        .sort((a, b) => a.id - b.id)
        .map((item) => OrderItemResponseDto.fromEntity(item)),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }
}
