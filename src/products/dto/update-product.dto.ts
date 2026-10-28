import { PartialType } from '@nestjs/swagger';

import { CreateProductDto } from './create-product.dto';

/**
 * Every field is optional. Supplying `images` replaces the whole image set of
 * the product, which keeps the primary/ordering rules of the set verifiable in
 * one step rather than across several partial updates.
 */
export class UpdateProductDto extends PartialType(CreateProductDto) {}
