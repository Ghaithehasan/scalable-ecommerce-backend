# المرحلة ٠ — تقرير قراءة المشروع الأساسي قبل بناء خدمة المخزون

**المتطلّب الثاني:** استخراج نطاق المخزون إلى خدمة مستقلّة تتواصل مع التطبيق الأساسي عبر gRPC
**نطاق هذه المرحلة:** قراءة وتحليل فقط — لا شيفرة
**التاريخ:** ٨ تشرين الثاني / نوفمبر ٢٠٢٦

> شجرة العمل **نظيفة تماماً** بعد هذه المرحلة: لم يُكتب أي ملف نهائي، ولم يُنفَّذ أي أمر git.
> أُنشئت ملفات فحص مؤقّتة وحُذفت، وهي مذكورة في القسم الأخير.

---

## ١. نوع معرّف المنتج

**عدد صحيح (`integer`)، وليس UUID.**

في [`src/products/entities/product.entity.ts`](../src/products/entities/product.entity.ts):

```ts
@PrimaryGeneratedColumn()
id!: number;
```

أي `serial` / `integer` في PostgreSQL. وكل المفاتيح الأجنبية التي تشير إليه
(`order_items.product_id` و `product_images.product_id`) من النوع `int`.

### الأثر على العقد

قرار جعل `product_id` من نوع `string` في ملف الـ proto **سليم**، لأنه يعزل العقد عن نوع
المعرّف في التطبيق الأساسي: لو تحوّل المشروع لاحقاً إلى UUID، لا يتغيّر العقد ولا تُعاد كتابة
خدمة المخزون.

لكنه يفرض تحويلاً صريحاً عند التكامل:

- التطبيق الأساسي يرسل `String(product.id)`.
- خدمة المخزون تخزّن `"1"`, `"2"`, `"3"` …
- بيانات الـ seed في المرحلة ٣ يجب أن تحمل المعرّفات الرقمية الحقيقية **كنصوص**.

**سؤال مفتوح للمرحلة ٣:** هل يقرأ الـ seed معرّفات المنتجات من قاعدة بيانات التطبيق
الأساسي تلقائياً، أم تُزرع معرّفات ثابتة (`"1"`..`"8"`) وتُضبط يدوياً؟

---

## ٢. هل يوجد عمود مخزون في المنتجات؟

**لا — ولا أثر له في أي مكان.**

كيان المنتج نفسه يوثّق القرار صراحةً:

> *A product deliberately carries no stock quantity: inventory is owned by the separate
> warehouse service introduced in requirement 2, and duplicating it here would create two
> conflicting sources of truth.*

بحثٌ عن `stock|quantity|inventory|warehouse` في كامل `src/` أعطى نتائج تخصّ **كمية سطر
الطلب** لا المخزون:

| الموضع | المعنى |
| --- | --- |
| `order_items.quantity` | الكمية المطلوبة في سطر الطلب |
| `CreateOrderItemDto.quantity` | نفس الشيء في جسم الطلب |
| `MAX_LINE_QUANTITY = 1000` | الحدّ الأعلى للتحقّق من المدخلات |

**الخلاصة:** الاستخراج نظيف — لا هجرة بيانات، ولا عمود يُحذف، ولا منطق قائم يُكسر.

---

## ٣. كيف يُنشأ الطلب حالياً

المسار: `OrdersService.create()` في [`src/orders/orders.service.ts`](../src/orders/orders.service.ts)

1. رفض المنتج المكرّر داخل نفس الطلب ← `400`.
2. حلقة إعادة محاولة (٥ مرات كحدّ أقصى) حول `placeOrder()`، تعيد **المعاملة كاملة** عند
   تصادم `order_number` (لأن خطأ التفرّد يُجهض المعاملة في PostgreSQL).
3. `placeOrder()` يفتح `dataSource.transaction(async (manager) => …)` وبداخلها:
   - `productsService.findByIds(ids, manager)` — قراءة الأسعار **داخل نفس المعاملة**.
   - منتج غير موجود ← `NotFoundException` · منتج معطّل ← `BadRequestException`.
   - بناء `OrderItemEntity` بنسخة `unitPrice` من الكتالوج (سعر وقت الشراء).
   - حساب `totalAmount` بالسنتات لتفادي انحراف الفاصلة العائمة.
   - `orderRepository.save(order)` مع `cascade: ['insert']` لحفظ الأسطر معه.
4. الحالة الابتدائية `PENDING`.

### نقطة جوهرية لمرحلة التكامل القادمة

لا يوجد حالياً **أي نداء شبكي داخل المعاملة**. عند إضافة `ReserveStock` يكون الترتيب الصحيح:

1. **الحجز قبل فتح المعاملة.** نداء شبكي داخل معاملة قاعدة بيانات يُطيل عمر الأقفال ويربط
   مصير المعاملة بزمن استجابة خدمة أخرى.
2. `try` / `catch` حول `placeOrder`، وعند أي فشل يُنادى `ReleaseStock` كعملية تعويض.
3. **انتباه خاص لحلقة إعادة المحاولة الموجودة:** يجب ألّا تُعيد الحجز عند كل محاولة، بل
   تُعيد المعاملة فقط بنفس `reservation_id`. هنا تظهر فائدة أن المُنادي هو من يولّد
   `reservation_id`.

---

## ٤. أي إعداد جذري يلتقط `inventory-service/` — بأدلّة عملية

أُنشئت ملفات فحص مؤقّتة: `inventory-service/src/probe.ts` (يحوي خطأ أنواع متعمّداً)،
و`probe.spec.ts`، و`test/probe.e2e-spec.ts`، ثم شُغّلت كل أداة وحُذفت الملفات.

| الإعداد | يلتقطه؟ | الدليل العملي | التعديل الأدنى |
| --- | --- | --- | --- |
| `tsconfig.json` | **نعم** | `tsc --noEmit` فشل بـ `inventory-service/src/probe.ts(1,14): error TS2322` | `exclude` — انظر التحذير أدناه |
| `tsconfig.build.json` | **لا** | `nest build` نجح (`exit=0`) رغم وجود الملف المكسور؛ `dist/main.js` موجود و`dist/src/main.js` غير موجود | **لا شيء مطلوب** |
| `jest.config.ts` (الجذر) | **نعم** | `--listTests` أدرج `inventory-service/src/probe.spec.ts` | `testPathIgnorePatterns` |
| `test/jest-e2e.json` | **لا** | `rootDir: "."` يُحلّ إلى مجلد `test/`؛ `--listTests` أدرج ملفات `test/` فقط | لا شيء |
| `.oxlintrc.json` + `npm run lint` | **لا** | السكربت مقيّد: `oxlint --type-aware src/ test/`؛ `exit=0` مع وجود الملف | لا شيء |
| `Dockerfile` | **لا** | ينسخ `package*.json` و`tsconfig*.json` و`nest-cli.json` و`src` فقط | لا شيء الآن |
| `.dockerignore` | يؤثّر على حجم سياق البناء فقط | — | إضافة `inventory-service/` |

### ⚠️ تصحيح لافتراض وارد في التعليمات

نصّت التعليمات على أن عدم استثناء `inventory-service` من `tsconfig.build.json` سيزيح
المخرجات إلى `dist/src/main.js` ويكسر النشر. **هذا لا يحدث فعلياً**، لأن
`tsconfig.build.json` يعرّف:

```json
"include": ["src"],
"compilerOptions": { "rootDir": "./src" }
```

و`include` يتجاوز الـ glob الضمني الموروث من الأب، و`rootDir` مثبّت صراحةً. أُثبت ذلك
عملياً: البناء نجح والمخرجات بقيت `dist/main.js` **مع وجود مجلد `inventory-service` فيه
ملف TypeScript مكسور**.

سيُضاف الاستثناء كما هو مطلوب (غير ضار، ويوثّق النية)، لكن يجب معرفة أنه **دفاعي لا
حاسم** — الحاسم هو `tsconfig.json` وحده.

### ⚠️ فخّ حقيقي في `tsconfig.json`

الملف حالياً **بلا `include` ولا `exclude`**، فيعمل بالقيم الافتراضية. وكتابة `exclude`
**تستبدل** الافتراضي بالكامل. نتيجة الاختبار بـ:

```json
"exclude": ["inventory-service"]
```

كانت: عدد الملفات قفز من **٦٥ إلى ١٢٤**، و**`dist/` دخل في التجميع** — أي إصلاح مشكلة
وخلق أسوأ منها (فحص أنواع للمخرجات المُصرَّفة).

الصيغة الصحيحة التي ستُستعمل:

```json
"exclude": ["node_modules", "dist", "inventory-service"]
```

وبالمثل في `jest.config.ts`، يجب الإبقاء على النمط الافتراضي لا استبداله:

```ts
testPathIgnorePatterns: ['/node_modules/', '/inventory-service/'],
```

---

## ٥. الإصدارات المستعملة (لمطابقتها في الخدمة الجديدة)

| الحزمة | المثبّت فعلاً |
| --- | --- |
| Node | `v24.16.0` محلياً · `node:24-slim` في الـ Dockerfile · لا يوجد حقل `engines` |
| `@nestjs/common` · `@nestjs/core` | **12.3.2** |
| `@nestjs/config` | 12.0.1 |
| `@nestjs/typeorm` | 12.0.2 |
| `@nestjs/microservices` | **غير مثبّت** — مطلوب في الخدمة الجديدة، وفي التطبيق الأساسي لاحقاً |
| `typeorm` | **1.1.2** |
| `typescript` | **6.0.3** |
| `pg` | 8.23.1 |
| `rxjs` | 7.8.2 |
| `reflect-metadata` | 0.2.2 |
| `class-validator` / `class-transformer` | 0.15.1 / 0.5.1 |
| `jest` / `ts-jest` | 30.5.2 / 29.4.15 |
| PostgreSQL | `postgres:17-alpine` في compose · 18.3 مثبّتة محلياً |

> **تنبيه:** NestJS 12 و TypeORM 1.x أحدث من المعرفة المدرَّبة للنموذج (TypeORM كان 0.3.x).
> قُرئت الإصدارات من `node_modules` لا من الذاكرة، وسيُتحقَّق من أي واجهة برمجية غير مألوفة
> من الملفات المثبّتة قبل استعمالها بدل الافتراض.

---

## ملاحظات إضافية من القراءة

- **المنافذ المشغولة:** `3000` (API) · `5432` (PostgreSQL محلي) · `5433` (PostgreSQL في
  compose الجذر). الخطة: **`5434`** لقاعدة المخزون و**`50051`** للـ gRPC.
- **`proto/` لن يلتقطه أي إعداد:** لا `tsconfig` (ليست ملفات `.ts`) ولا `jest` ولا
  `Dockerfile`. وعدم إضافته إلى `.dockerignore` قرار صحيح — لكن يجب الانتباه أن
  `Dockerfile` الجذر سيحتاج سطر `COPY proto ./proto` عند تحويل التطبيق إلى عميل gRPC.
- `.dockerignore` لا يستثني `http/` المضاف حديثاً، فيُرسَل ضمن سياق البناء. خارج صلاحيات
  هذه الجلسة، مذكور للعلم فقط.
- قاعدة المرحلة ٣ بخصوص `synchronize: false` تخالف التطبيق الأساسي الذي يستعمل
  `synchronize: true`، وهذا **مقصود وصحيح**: خدمة المخزون تحمل بيانات حسّاسة وتستحق هجرات
  صريحة ومراجَعة.

---

## الملفات المؤقّتة التي أُنشئت وحُذفت

```
inventory-service/src/probe.ts
inventory-service/src/probe.spec.ts
inventory-service/test/probe.e2e-spec.ts
tsconfig.probe.json
```

التحقّق بعد الحذف: `git status --porcelain` فارغ، و`dist/main.js` سليم بعد إعادة البناء.

---

## الحالة

**انتهت المرحلة ٠.** الخطوة التالية: المرحلة ١ — إنشاء ملف العقد
`proto/inventory/v1/inventory.proto`.
