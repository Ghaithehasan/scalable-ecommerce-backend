import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Every failure leaves the application in the same JSON shape.
  app.useGlobalFilters(new AllExceptionsFilter());

  const openApi = new DocumentBuilder()
    .setTitle('Scalable E-Commerce API')
    .setDescription(
      'Requirement 1: users, products and orders over a secured REST API. ' +
        'Authenticate with POST /auth/login and send the returned token as a ' +
        'Bearer token.',
    )
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addTag('auth', 'Registration, login and the current account')
    .addTag('users', 'User accounts')
    .addTag('categories', 'Product categories')
    .addTag('products', 'Catalogue: products and their images')
    .addTag('orders', 'Orders and order lines')
    .build();

  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(app, openApi),
    { swaggerOptions: { persistAuthorization: true } },
  );

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
void bootstrap();
