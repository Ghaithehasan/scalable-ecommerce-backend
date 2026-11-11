# دليل ربط واجهة الويب مع E-Commerce API

هذا الملف مخصّص لفريق الفرونت إند ويصف واجهة **HTTP** في مشروع Main API (`scalable-ecommerce-backend`). جميع المسارات هنا مأخوذة من الكود الحالي في `src`؛ لا يوجد prefix من نوع `/api/v1`. محلياً عنوان الخدمة `http://localhost:3000`، وفي النشر استبدلوا الأصل بعنوان الـ API الذي يوفّره الـ reverse proxy. صفحة Swagger أثناء تشغيل الخدمة: `/docs`.

الفرونت إند يتصل بالـ Main API فقط. خدمة Inventory تتواصل مع Main داخلياً عبر gRPC، ولا توجد في التطبيق الحالي REST endpoints عامة لقراءة المخزون أو تعديله مباشرةً. الكمية تظهر ضمن ردود المنتجات، والحجز يتم عند إنشاء الطلب.

## قواعد عامة مهمة

- كل المسارات محمية بـ `Authorization: Bearer <accessToken>` **ما عدا** `POST /auth/register` و`POST /auth/login`. الـ token صالح لمدة `expiresIn` ثانية (الافتراضي 900 = 15 دقيقة). لا يوجد endpoint لتجديده؛ بعد انتهائه أعيدوا تسجيل الدخول.
- عندما يوجد body أرسلوا `Content-Type: application/json`. أسماء الحقول في JSON بصيغة `camelCase` مثل `productId` و`availableQuantity`.
- الصلاحيات: `CUSTOMER` زبون، و`RESPONSIBLE` مدير. التسجيل العام وإنشاء مستخدم عبر `/users` ينشئان حساب `CUSTOMER`؛ لا يُقبل حقل `role` في body.
- قيم `createdAt` و`updatedAt` في JSON نصوص ISO 8601. الأرقام والمعرّفات في الأمثلة للتوضيح، والـ IDs الفعلية تُقرأ من ردود الخدمة.
- الـ body يقبل الحقول الموثّقة فقط. إرسال حقل إضافي مثل `role` عند التسجيل أو `availableQuantity` عند إنشاء منتج يعطي HTTP `400`.
- مسارات القوائم الثلاثة (`/categories` و`/products` و`/orders`) تقبل `page` (عدد صحيح ≥ 1، افتراضياً 1) و`limit` (عدد صحيح من 1 إلى 100، افتراضياً 20). `GET /users` يرجع مصفوفة عادية بلا pagination.
- إذا كان موقع الويب وAPI على أصلين مختلفين (domain/port مختلفين)، يحتاج إعداد CORS في الـ Main أو reverse proxy يخدمهما من أصل واحد؛ `src/main.ts` الحالي لا يفعّل CORS.

### شكل رد الصفحة

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 0,
    "hasNextPage": false,
    "hasPreviousPage": false
  }
}
```

`data` تحمل النوع المناسب للمسار: `Category[]` أو `Product[]` أو `Order[]`. عدد الصفحات يساوي 0 إذا لم توجد نتائج.

### شكل الأخطاء

كل خطأ يرجع JSON بنفس البناء:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": ["quantity must not be less than 1"],
  "path": "/orders",
  "timestamp": "2026-11-11T08:00:00.000Z"
}
```

`message` قد تكون `string` أو `string[]` في أخطاء التحقق. استخدموا `statusCode` لاتخاذ القرار و`message` للعرض. أهم الحالات: `400` بيانات غير صالحة، `401` token مفقود/منتهي أو معلومات دخول خاطئة، `403` الصلاحية أو الملكية تمنع العملية، `404` السجل غير موجود، `409` تعارض مثل stock غير كافٍ أو انتقال حالة غير مسموح، `429` تجاوز معدل الطلبات، `503` تعذّر تأكيد عملية المخزون، و`500` خطأ غير متوقع.

## أشكال البيانات التي ترجع من API

الأنواع أدناه هي صيغة مختصرة لفهم الردود. `Date` في الـ TypeScript على السيرفر يُرسل إلى المتصفح كنص ISO.

```ts
type Role = 'CUSTOMER' | 'RESPONSIBLE';
type Gender = 'MALE' | 'FEMALE';
type OrderStatus = 'PENDING' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
type IsoDate = string;

type User = {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  gender: Gender;
  role: Role;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

type AuthResponse = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number; // seconds
  user: User;
};

type Category = {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

type ProductImage = {
  id: number;
  imageUrl: string;
  isPrimary: boolean;
  sortOrder: number;
};

type Product = {
  id: number;
  name: string;
  description: string | null;
  price: number;
  availableQuantity: number | null;
  categoryId: number;
  category: Category | null;
  isActive: boolean;
  images: ProductImage[];
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

type OrderItem = {
  id: number;
  productId: number;
  productName: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

type Order = {
  id: number;
  orderNumber: string;
  inventoryReservationId: string | null;
  userId: number;
  status: OrderStatus;
  totalAmount: number;
  items: OrderItem[];
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

type Page<T> = {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
};
```

`availableQuantity: 0` يعني المخزون معروف ومنتهٍ. `availableQuantity: null` يعني أن الخدمة لم ترجع كمية لهذا المنتج، أو أن قراءة Inventory تعذّرت مؤقتاً. لا تعاملوا `null` على أنها صفر مؤكد. إنشاء منتج في Main **لا ينشئ stock تلقائياً**؛ لا يوجد حالياً HTTP endpoint لإدخال stock من الواجهة. `inventoryReservationId` معرّف داخلي مرتبط بحجز الطلب وقد يكون `null` في الطلبات القديمة.

## 1. الحسابات وتسجيل الدخول

### `POST /auth/register` — تسجيل زبون جديد

**الوصول:** عام. **الطلب:** body من نوع `CreateUser` التالي:

```json
{
  "name": "Maya Demo",
  "email": "maya@example.com",
  "phone": "+963912345678",
  "gender": "FEMALE",
  "password": "MyStrongPassword123!"
}
```

| حقل | القاعدة |
| --- | --- |
| `name` | مطلوب، نص غير فارغ، حد أقصى 100 حرف |
| `email` | مطلوب، بريد إلكتروني صالح، حد أقصى 255 حرف، فريد |
| `phone` | اختياري أو `null`؛ يبدأ اختيارياً بـ `+` ثم رقم من 1–9 ثم 7–14 أرقام؛ فريد إن وُجد |
| `gender` | مطلوب: `MALE` أو `FEMALE` |
| `password` | مطلوب، 8 أحرف على الأقل و72 بايت UTF-8 كحد أقصى |

**الرد:** HTTP `201` مع `AuthResponse`، وفيه token وبيانات `User`، ودور المستخدم `CUSTOMER`. حقل `password` أو hash لا يرجع. البريد أو الهاتف الموجود مسبقاً يعطي `409`. الحد: 5 محاولات بالدقيقة تقريباً لكل عميل/مسار (`429` عند تجاوزه).

مثال الرد نفسه المستخدم عند تسجيل الدخول:

```json
{
  "accessToken": "<JWT>",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "user": {
    "id": 17,
    "name": "Maya Demo",
    "email": "maya@example.com",
    "phone": "+963912345678",
    "gender": "FEMALE",
    "role": "CUSTOMER",
    "createdAt": "2026-11-11T08:00:00.000Z",
    "updatedAt": "2026-11-11T08:00:00.000Z"
  }
}
```

### `POST /auth/login` — تسجيل الدخول

**الوصول:** عام. **الطلب:**

```json
{ "email": "maya@example.com", "password": "MyStrongPassword123!" }
```

`email` بريد صالح حتى 255 حرف. `password` نص غير فارغ وحتى 72 بايت UTF-8. **الرد:** HTTP `200` مع `AuthResponse` أعلاه. بريد غير موجود أو كلمة سر خاطئة يعطي `401` بنفس الرسالة، والحد 5 محاولات بالدقيقة تقريباً (`429`). ردود register/login تحمل `Cache-Control: no-store`.

### `GET /auth/me` — المستخدم الحالي

**الوصول:** أي مستخدم مسجل. **الطلب:** Bearer token فقط. **الرد:** HTTP `200` مع `User` أعلاه. استخدموه لجلب الدور وبيانات الحساب بعد تحديث الصفحة؛ المستخدم المحذوف أو token المنتهي يعطي `401`. الرد يحمل `Cache-Control: no-store`.

## 2. المستخدمون

### `GET /users` — جميع المستخدمين

**الوصول:** `RESPONSIBLE` فقط. **الطلب:** Bearer token؛ لا توجد query parameters للقائمة. **الرد:** HTTP `200` مع `User[]` مباشرةً، مثل `[ { ...User }, ... ]`؛ لا يوجد كائن `data/meta` ولا password hashes. الزبون يحصل على `403`.

### `GET /users/:id` — مستخدم محدد

**الوصول:** صاحب الحساب نفسه أو `RESPONSIBLE`. **الطلب:** `id` في المسار (عدد صحيح) وBearer token. **الرد:** HTTP `200` مع `User`. مستخدم آخر للزبون يعطي `403`، وID غير موجود يعطي `404`.

### `POST /users` — إنشاء زبون من لوحة الإدارة

**الوصول:** `RESPONSIBLE` فقط. **الطلب:** نفس body وقواعد `POST /auth/register` (`CreateUser`). **الرد:** HTTP `201` مع `User` فقط، من دون token. الحساب الجديد `CUSTOMER`. بريد/هاتف مكرر يعطي `409`؛ الزبون العادي يحصل على `403`.

## 3. الفئات

### `GET /categories` — قائمة الفئات

**الوصول:** أي مستخدم مسجل. **الطلب:** query اختيارية `page`, `limit`, `isActive=true|false`. بدون `isActive` تُرجع الفئات النشطة وغير النشطة. **الرد:** HTTP `200` مع `Page<Category>`؛ الترتيب بالاسم تصاعدياً ثم ID. قيمة `isActive` غير `true`/`false` تعطي `400`.

مثال: `GET /categories?page=1&limit=20&isActive=true`.

### `GET /categories/:id` — فئة واحدة

**الوصول:** أي مستخدم مسجل. **الطلب:** ID في المسار. **الرد:** HTTP `200` مع `Category`، أو `404` إذا غير موجودة. مثال:

```json
{
  "id": 3,
  "name": "Electronics",
  "slug": "electronics",
  "description": "Everyday devices and accessories",
  "isActive": true,
  "createdAt": "2026-11-11T08:00:00.000Z",
  "updatedAt": "2026-11-11T08:00:00.000Z"
}
```

### `POST /categories` — إنشاء فئة

**الوصول:** `RESPONSIBLE`. **الطلب:**

```json
{
  "name": "Electronics",
  "slug": "electronics",
  "description": "Everyday devices and accessories",
  "isActive": true
}
```

`name` مطلوب وغير فارغ وحتى 100 حرف. `slug` اختياري، من حروف إنجليزية صغيرة وأرقام وشرطات مفردة وحتى 100 حرف؛ إذا غاب يُشتق من الاسم. `description` اختياري أو `null` وحتى 2000 حرف؛ `isActive` اختياري وافتراضياً `true`. **الرد:** HTTP `201` مع `Category`. تكرار slug يعطي `409`.

### `PATCH /categories/:id` — تعديل فئة

**الوصول:** `RESPONSIBLE`. **الطلب:** ID وbody يحتوي أي جزء من حقول إنشاء الفئة، مثل `{ "name": "Home & Kitchen", "isActive": false }`. **الرد:** HTTP `200` مع `Category` بعد التعديل. ID غير موجود يعطي `404`، وslug مكرر يعطي `409`. تغيير الاسم وحده لا يعيد اشتقاق slug؛ أرسلوه صراحةً إذا أردتم تغييره.

### `DELETE /categories/:id` — حذف فئة

**الوصول:** `RESPONSIBLE`. **الطلب:** ID فقط. **الرد:** HTTP `204` بلا body. ID غير موجود يعطي `404`، والفئة التي تحتوي منتجات تعطي `409`.

## 4. المنتجات والمخزون المعروض

### `GET /products` — قائمة المنتجات

**الوصول:** أي مستخدم مسجل. **الطلب:** query اختيارية `page`, `limit`, `categoryId` (عدد صحيح موجب)، `isActive=true|false`. `categoryId` غير موجود يعطي `404`. للزبون تظهر المنتجات النشطة فقط حتى لو أرسل `isActive=false`؛ للمدير يمكن تصفية النشط أو غير النشط أو عرض الاثنين عند غياب المرشح. **الرد:** HTTP `200` مع `Page<Product>`، الأحدث إنشاءً أولاً ثم ID تنازلياً.

مثال: `GET /products?page=1&limit=12&categoryId=3`.

### `GET /products/:id` — تفاصيل منتج

**الوصول:** أي مستخدم مسجل. **الطلب:** ID في المسار. **الرد:** HTTP `200` مع `Product`. المنتج غير الموجود يعطي `404`، والمنتج غير النشط يعطي `404` للزبون أيضاً. مثال:

```json
{
  "id": 42,
  "name": "Wireless Compact Keyboard",
  "description": "A compact wireless keyboard",
  "price": 34.9,
  "availableQuantity": 5,
  "categoryId": 3,
  "category": {
    "id": 3,
    "name": "Electronics",
    "slug": "electronics",
    "description": "Everyday devices and accessories",
    "isActive": true,
    "createdAt": "2026-11-11T08:00:00.000Z",
    "updatedAt": "2026-11-11T08:00:00.000Z"
  },
  "isActive": true,
  "images": [
    { "id": 11, "imageUrl": "https://cdn.example.com/keyboard.jpg", "isPrimary": true, "sortOrder": 0 }
  ],
  "createdAt": "2026-11-11T08:00:00.000Z",
  "updatedAt": "2026-11-11T08:00:00.000Z"
}
```

### `POST /products` — إنشاء منتج

**الوصول:** `RESPONSIBLE`. **الطلب:**

```json
{
  "name": "Wireless Compact Keyboard",
  "description": "A compact wireless keyboard",
  "price": 34.9,
  "categoryId": 3,
  "isActive": true,
  "images": [
    { "imageUrl": "https://cdn.example.com/keyboard.jpg", "isPrimary": true, "sortOrder": 0 }
  ]
}
```

| حقل | القاعدة |
| --- | --- |
| `name` | مطلوب، نص غير فارغ حتى 100 حرف |
| `description` | اختياري أو `null` حتى 5000 حرف |
| `price` | مطلوب، رقم موجب بحد أقصى منزلتين عشريتين وحتى `99999999.99` |
| `categoryId` | مطلوب، عدد صحيح موجب لفئة موجودة |
| `isActive` | اختياري، boolean، افتراضياً `true` |
| `images` | اختياري، مصفوفة من 0 إلى 10 صور |

كل صورة: `imageUrl` مطلوب كرابط `http`/`https` حتى 255 حرف؛ `isPrimary` اختياري boolean؛ `sortOrder` اختياري عدد صحيح من 0 إلى 1000. صورة أساسية واحدة كحد أقصى؛ إذا لم تُحدد صورة أساسية، تصبح الأولى أساسية تلقائياً. **الرد:** HTTP `201` مع `Product`، وغالباً `availableQuantity: null` إلى أن يجهّز المخزون في Inventory. فئة غير موجودة تعطي `404`.

### `PATCH /products/:id` — تعديل منتج

**الوصول:** `RESPONSIBLE`. **الطلب:** ID وbody من أي جزء من حقول إنشاء المنتج. مثال: `{ "price": 29.9, "isActive": false }`. إرسال `images` يستبدل **كل الصور**: `images: []` يمسحها، وغياب `images` يبقيها. **الرد:** HTTP `200` مع `Product` بعد التعديل. ID أو `categoryId` غير موجود يعطي `404`. قواعد السعر والصور نفسها تنطبق.

### `DELETE /products/:id` — حذف منتج

**الوصول:** `RESPONSIBLE`. **الطلب:** ID فقط. **الرد:** HTTP `204` بلا body. غير الموجود `404`. إذا ظهر المنتج في أي طلب شراء، يعطي `409`؛ يمكن إخفاؤه بواسطة `PATCH /products/:id` مع `{ "isActive": false }`.

## 5. الطلبات

### `POST /orders` — إنشاء طلب وحجز المخزون

**الوصول:** أي مستخدم مسجل. الطلب يرتبط بصاحب الـ token تلقائياً؛ لا ترسلوا `userId` ولا السعر في body.

```http
POST /orders
Authorization: Bearer <accessToken>
Content-Type: application/json
Idempotency-Key: checkout-8f2a1
```

```json
{
  "items": [
    { "productId": 42, "quantity": 2 },
    { "productId": 51, "quantity": 1 }
  ]
}
```

`items`: من 1 إلى 50 سطراً. `productId`: عدد صحيح موجب ضمن المجال `1..2147483647`، ولا تكرروا المنتج في سطرين. `quantity`: عدد صحيح من 1 إلى 1000. لا يمكن أن يتجاوز الإجمالي `99999999.99`. الأسعار تؤخذ من بيانات المنتجات على السيرفر وتُحفظ مع بنود الطلب.

**الرد عند النجاح:** HTTP `201` مع `Order` حالته `PENDING`. مثال:

```json
{
  "id": 90,
  "orderNumber": "ORD-20261111-9F3K2Q",
  "inventoryReservationId": "550e8400-e29b-41d4-a716-446655440000",
  "userId": 17,
  "status": "PENDING",
  "totalAmount": 89.7,
  "items": [
    { "id": 201, "productId": 42, "productName": "Wireless Compact Keyboard", "quantity": 2, "unitPrice": 34.9, "lineTotal": 69.8 },
    { "id": 202, "productId": 51, "productName": "Ergonomic Wireless Mouse", "quantity": 1, "unitPrice": 19.9, "lineTotal": 19.9 }
  ],
  "createdAt": "2026-11-11T08:00:00.000Z",
  "updatedAt": "2026-11-11T08:00:00.000Z"
}
```

**مهم لإعادة المحاولة:** أنشئوا `Idempotency-Key` واحداً لكل محاولة شراء منطقية، واحتفظوا **بنفس القيمة** إذا تأخر الرد أو انقطع الاتصال. المفتاح اختياري في API لكن بدونه كل إرسال جديد قد يُعدّ عملية مستقلة. القيم المسموحة: 1–100 حرف، أول حرف حرف إنجليزي أو رقم، ثم حروف/أرقام/نقطة/شرطة سفلية/نقطتان/شرطة (`A-Z a-z 0-9 . _ : -`). نفس المستخدم + نفس المفتاح + نفس المنتجات والكميات بعد اكتمال العملية يرجع الطلب نفسه. تغيير المحتوى مع المفتاح نفسه، أو وجود عملية لم تُحسم بعد، يعطي `409`. لا تولّدوا مفتاحاً جديداً لمجرد وصول `503` أو انتهاء مهلة اتصال الواجهة؛ أعيدوا الطلب بنفس المفتاح للتحقق من النتيجة. لا يوجد endpoint منفصل لفحص حالة العملية.

أخطاء مفيدة للواجهة: منتج غير موجود `404`؛ منتج غير نشط أو عناصر مكررة/غير صالحة `400`؛ مخزون غير كافٍ `409`؛ خدمة المخزون غير متاحة أو مهلة التأكيد انتهت `503`. لا تفترضوا نجاح الحجز من الكمية التي ظهرت في صفحة المنتج؛ إنشاء الطلب هو العملية الحاسمة.

### `GET /orders` — قائمة الطلبات

**الوصول:** أي مستخدم مسجل. **الطلب:** `page`, `limit`, `status` (قيمة من `OrderStatus`)، و`userId` (عدد صحيح موجب). الزبون يرى طلباته فقط؛ إذا أرسل `userId` لمستخدم آخر يحصل على `403`. `RESPONSIBLE` يرى الكل، ويمكنه التصفية بـ `userId`. **الرد:** HTTP `200` مع `Page<Order>`، الأحدث أولاً. مثال: `GET /orders?page=1&limit=10&status=PENDING`.

### `GET /orders/:id` — تفاصيل طلب

**الوصول:** صاحب الطلب أو `RESPONSIBLE`. **الطلب:** ID في المسار. **الرد:** HTTP `200` مع `Order`. ID غير موجود يعطي `404`، وطلب يخص مستخدماً آخر للزبون يعطي `403`.

### `PATCH /orders/:id/status` — تغيير حالة الطلب

**الوصول:** `RESPONSIBLE` فقط. **الطلب:** ID في المسار وbody مثل `{ "status": "CONFIRMED" }`. **الرد:** HTTP `200` مع `Order` بالحالة الجديدة. الحالات الممكنة:

```text
PENDING ──▶ CONFIRMED ──▶ SHIPPED ──▶ DELIVERED
   │             │
   └─────────────┴──────▶ CANCELLED
```

إرسال الحالة الحالية مرة أخرى يرجع الطلب دون تغيير. انتقال غير مسموح يعطي `409`؛ ID غير موجود `404`، والزبون `403`. عند الإلغاء تُسجّل عملية تحرير المخزون وتُعاد محاولة تنفيذها إذا تأخرت، لذلك قد لا تتغير الكمية المعروضة فوراً.

### `DELETE /orders/:id` — حذف طلب

**الوصول:** `RESPONSIBLE` فقط. **الطلب:** ID فقط. **الرد:** HTTP `204` بلا body، أو `404` إذا غير موجود. حذف طلب `PENDING` أو `CONFIRMED` يطلب تحرير الحجز؛ حذف سجل طلب `SHIPPED` أو `DELIVERED` لا يعيد المخزون المباع. التحرير قد يكتمل لاحقاً إذا تعذّر الاتصال مؤقتاً بخدمة Inventory.

## ملخص المسارات للنسخ السريع

| العملية | المسار | الوصول | المدخلات | رد النجاح |
| --- | --- | --- | --- | --- |
| POST | `/auth/register` | عام | `CreateUser` | `201 AuthResponse` |
| POST | `/auth/login` | عام | `email`, `password` | `200 AuthResponse` |
| GET | `/auth/me` | مستخدم مسجل | token | `200 User` |
| GET | `/users` | RESPONSIBLE | token | `200 User[]` |
| GET | `/users/:id` | صاحب الحساب/RESPONSIBLE | ID | `200 User` |
| POST | `/users` | RESPONSIBLE | `CreateUser` | `201 User` |
| GET | `/categories` | مستخدم مسجل | `page`, `limit`, `isActive` | `200 Page<Category>` |
| GET | `/categories/:id` | مستخدم مسجل | ID | `200 Category` |
| POST | `/categories` | RESPONSIBLE | بيانات فئة | `201 Category` |
| PATCH | `/categories/:id` | RESPONSIBLE | ID + حقول فئة اختيارية | `200 Category` |
| DELETE | `/categories/:id` | RESPONSIBLE | ID | `204` بلا body |
| GET | `/products` | مستخدم مسجل | `page`, `limit`, `categoryId`, `isActive` | `200 Page<Product>` |
| GET | `/products/:id` | مستخدم مسجل | ID | `200 Product` |
| POST | `/products` | RESPONSIBLE | بيانات منتج | `201 Product` |
| PATCH | `/products/:id` | RESPONSIBLE | ID + حقول منتج اختيارية | `200 Product` |
| DELETE | `/products/:id` | RESPONSIBLE | ID | `204` بلا body |
| POST | `/orders` | مستخدم مسجل | `items` + مفتاح اختياري | `201 Order` |
| GET | `/orders` | مستخدم مسجل | `page`, `limit`, `status`, `userId` | `200 Page<Order>` |
| GET | `/orders/:id` | صاحب الطلب/RESPONSIBLE | ID | `200 Order` |
| PATCH | `/orders/:id/status` | RESPONSIBLE | ID + `status` | `200 Order` |
| DELETE | `/orders/:id` | RESPONSIBLE | ID | `204` بلا body |

لا توجد في `AppModule` الحالي route جذرية `/`، وإن وُجد ملف `app.controller.ts` في المصدر؛ اعتمدوا المسارات أعلاه. تحديثات هذا الملف يجب مراجعتها عند تغيير الـ controllers والـ DTOs.
