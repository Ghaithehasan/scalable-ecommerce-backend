# المرحلة ١ — العقد (proto) والتحقّق من سلسلة الأدوات

**المتطلّب الثاني:** استخراج نطاق المخزون إلى خدمة مستقلّة تتواصل مع التطبيق الأساسي عبر gRPC
**نطاق هذه المرحلة:** إنشاء ملف العقد + التحقّق العملي من توافق الأدوات مع NestJS 12
**التاريخ:** ٨ تشرين الثاني / نوفمبر ٢٠٢٦
**المرحلة السابقة:** [`inventory-service-phase-0-ar.md`](inventory-service-phase-0-ar.md)

---

## ١. ما أُنشئ

ملف واحد فقط:

```
proto/inventory/v1/inventory.proto
```

### تنبيه على الأمانة

أُضيفت تعليقات إنجليزية توثّق قرارات التصميم الأربعة داخل الملف. **لم يُغيَّر أي اسم حقل،
ولا رقم حقل، ولا نوع** — العقد على السلك مطابق حرفياً للمواصفة المُعطاة. التعليقات قابلة
للحذف إن كان المطلوب ملفاً مجرّداً.

---

## ٢. العقد

### العمليات الثلاث

| العملية | الطلب | الاستجابة | الغرض |
| --- | --- | --- | --- |
| `GetStock` | `repeated string product_ids` | `repeated StockLevel items` | قراءة دفعية للمستويات؛ المعرّفات المجهولة تُحذف من الاستجابة بدل أن تكون خطأ |
| `ReserveStock` | `reservation_id` + `repeated ReserveItem` | `bool reserved` + `repeated Shortage` | فحص وحجز ذرّي لكل الأصناف معاً |
| `ReleaseStock` | `reservation_id` | `bool released` | إعادة كميات حجزٍ إلى المتاح |

### الرسائل

| الرسالة | الحقول |
| --- | --- |
| `StockLevel` | `product_id`, `available`, `reserved` |
| `ReserveItem` | `product_id`, `quantity` |
| `Shortage` | `product_id`, `requested`, `available` |

### قرارات التصميم المُرمَّزة في الملف

**١. `product_id` نصّ لا عدد.** التطبيق الأساسي يستعمل مفاتيح `integer` حالياً، لكن العقد
يجب ألّا يعتمد على ذلك: لو انتقل الكتالوج إلى UUID مستقبلاً يبقى هذا الملف وخدمة المخزون
دون تغيير. التحويل مسؤولية المُنادي: `String(product.id)`.

**٢. `reservation_id` يولّده المُنادي (UUID) قبل النداء.** هذا ما يجعل كل عملية
**idempotent**: إعادة المحاولة بعد انقطاع لا تحجز مرّتين، وعملية التعويض `ReleaseStock`
تستطيع دائماً تسمية الحجز الذي تُلغيه حتى لو لم تصل الاستجابة الأصلية أبداً.

**٣. "لا توجد كمية كافية" نتيجة تجارية لا خطأ تقني.** تُبلَّغ في الاستجابة بـ
`reserved = false` مع قائمة النواقص، فيستطيع التطبيق أن يُظهر للمستخدم أي صنف نقص بالضبط.
رموز حالة gRPC محجوزة للمشاكل التقنية وحدها:

| الرمز | متى |
| --- | --- |
| `INVALID_ARGUMENT` | `reservation_id` مفقود، أو `items` فارغة، أو `quantity <= 0`، أو منتج مكرّر في نفس الطلب |
| `NOT_FOUND` | معرّف منتج لا تعرفه خدمة المخزون |
| `FAILED_PRECONDITION` | `ReserveStock` على `reservation_id` سبق تحريره (`RELEASED`) |
| `INTERNAL` | أي خطأ غير متوقّع، بلا تسريب تفاصيل داخلية |

**٤. `ReserveStock` كل-أو-لا-شيء.** إمّا تُحجز كل الأصناف أو لا شيء، والاستجابة تُدرج
**كل** النواقص لا أوّلها فقط.

---

## ٣. التحقّق من سلسلة الأدوات

نُفِّذ كامل التحقّق في مجلد مؤقّت خارج المستودع. **لم يُلمَس `package.json` ولا
`node_modules` ولا أي ملف قائم.**

### الإصدارات المتاحة

| الحزمة | الإصدار |
| --- | --- |
| `@nestjs/microservices` | 12.4.0 (وخطّ 12.3.2 موجود، يطابق `@nestjs/common` في المشروع) |
| `ts-proto` | 2.18.4 |
| `@bufbuild/buf` | 1.75.0 |
| `@grpc/grpc-js` | 1.14.7 |
| `@grpc/proto-loader` | 0.8.1 |
| `@grpc/reflection` | 1.0.4 |
| `grpc-health-check` | 2.1.0 |

### تحميل العقد

العقد يُحلَّل بنجاح: المسار `/inventory.v1.InventoryService/GetStock`، والدوالّ الثلاث
موجودة. و`keepCase: false` يعطي `reservationId` و`productId`، و`defaults: true` يُحضر
القيم الصفرية فعلاً:

```
round-trip:       {"items":[{"productId":"7","quantity":2}],"reservationId":"r-1"}
defaults present: {"shortages":[],"reserved":false}
```

### الاختبار الحاسم — خدمة Nest 12 حقيقية بعميل gRPC حقيقي

صُرِّف بـ TypeScript **6.0.3** (مُثبَّت ليطابق المشروع؛ `npx` كان يجلب ٧ تلقائياً) وبنفس
`compilerOptions` المستعملة في المستودع. النتيجة:

```
GetStock              -> {"items":[{"productId":"1","available":5,"reserved":0}, …]}
ReserveStock ok       -> {"shortages":[],"reserved":true}
ReserveStock shortage -> {"shortages":[{"productId":"1","requested":99,"available":5}],"reserved":false}
RpcException          -> code=3 (INVALID_ARGUMENT=3) details="reservation_id is required"
ReleaseStock          -> {"released":true}
```

أي أن المزخرِف `@InventoryServiceControllerMethods()` المولَّد من ts-proto يسجّل الدوالّ
الثلاث مع Nest 12 بنجاح، وأن `RpcException({ code: status.X })` يُترجَم إلى رمز gRPC
الصحيح.

---

## ٤. اكتشافان كانا سيُسبّبان أعطالاً

### ⚠️ ١. `@bufbuild/protobuf` اعتماد وقت تشغيل خفيّ

التوليد الافتراضي لـ ts-proto 2.x يُصدر:

```ts
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
```

وهذه الحزمة مثبّتة **بالتبعية** عبر `ts-proto` التي هي `devDependency`. في صورة Docker مع
`npm ci --omit=dev` كانت الخدمة ستنهار عند الإقلاع بـ `MODULE_NOT_FOUND`.

**الحل المختار أفضل من مجرّد إضافتها كاعتماد:** بما أن التسلسل الفعلي يقوم به
`@grpc/proto-loader` لا ts-proto، فإن دوالّ `encode`/`decode` المولَّدة شيفرة ميتة أصلاً.
بإلغائها:

| | قبل | بعد |
| --- | --- | --- |
| عدد الأسطر | ٦٦٨ | **١١٧** |
| الاستيرادات | `@bufbuild/protobuf/wire`, `@grpc/grpc-js`, `@nestjs/microservices`, `rxjs` | `@nestjs/microservices`, `rxjs` فقط |
| اعتمادات إضافية وقت التشغيل | واحدة | **صفر** |

### ⚠️ ٢. `createMicroservice` يأخذ وسيطين في Nest 12

التوقيع الفعلي المقروء من `node_modules`:

```ts
createMicroservice<T extends object>(
  moduleCls: IEntryNestModule,
  options?: NestMicroserviceOptions & T,
): Promise<INestMicroservice>;
```

فـ `logger` و`bufferLogs` وبقية خيارات التطبيق تُدمج **داخل نفس كائن الخيارات**، لا كوسيط
ثالث. كتابتها كوسيط ثالث تفشل بـ `error TS2554: Expected 1-2 arguments, but got 3`.

الصيغة الصحيحة:

```ts
await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
  transport: Transport.GRPC,
  options: { url, package: INVENTORY_V1_PACKAGE_NAME, protoPath, loader: { … } },
  logger: ['error', 'warn', 'log'],
});
```

---

## ٥. إعدادات التوليد المعتمدة للمرحلة ٢

`inventory-service/buf.gen.yaml`:

```yaml
version: v2
clean: true
plugins:
  - local: protoc-gen-ts_proto
    out: src/generated
    opt:
      - nestJs=true
      - outputEncodeMethods=false
      - outputJsonMethods=false
      - outputClientImpl=false
      - esModuleInterop=true
      - snakeToCamel=true
```

يُنادى بـ `buf generate ../proto` من داخل `inventory-service/`، **عبر سكربت npm** حتى يضع
npm مجلد `node_modules/.bin` على `PATH` فيعثر buf على الإضافة `protoc-gen-ts_proto`.

### ما يُنتجه التوليد

| الرمز | الاستعمال |
| --- | --- |
| `InventoryServiceController` | واجهة يُنفّذها المتحكّم |
| `InventoryServiceControllerMethods()` | مزخرِف يسجّل الدوالّ الثلاث عبر `@GrpcMethod` |
| `InventoryServiceClient` | واجهة العميل (يحتاجها التطبيق الأساسي لاحقاً) |
| `INVENTORY_V1_PACKAGE_NAME` | ثابت اسم الحزمة |
| واجهات الرسائل | بأسماء camelCase مطابقة لما يُنتجه proto-loader وقت التشغيل |

سكربتات الاختبار و`race-demo` ستستعمل `@grpc/proto-loader` مباشرةً لبناء العميل — وهو
مسار تحقّقنا من عمله بالفعل — فلا حاجة لتوليد تعريف خدمة grpc-js.

---

## ٦. تأكيدات تخصّ المرحلة ٢

`GrpcOptions` في Nest 12 يحتوي فعلاً كل ما خُطِّط له:

| الحقل | الاستعمال المخطَّط |
| --- | --- |
| `onLoadPackageDefinition?: (pkg, server) => void` | تسجيل `grpc.health.v1` و server reflection |
| `gracefulShutdown?: boolean` | الإغلاق السلس |
| `loader.includeDirs` | حلّ مسار `proto/` محلياً وداخل Docker |
| `url`, `package`, `protoPath` | التهيئة الأساسية |

---

## ٧. حالة المستودع

```
?? docs/inventory-service-phase-0-ar.md
?? docs/inventory-service-phase-1-ar.md
?? proto/
```

ملفات جديدة غير مُتتبَّعة فقط. **لا تعديل على أي ملف قائم، ولم يُنفَّذ أي أمر git.**

---

## الخطوة التالية

**المرحلة ٢ — هيكل خدمة NestJS**، وتبدأ بتعديلات الجذر المصرَّح بها:

1. `tsconfig.json` ← `"exclude": ["node_modules", "dist", "inventory-service"]`
2. `tsconfig.build.json` ← إضافة `inventory-service` إلى `exclude` (دفاعي)
3. `jest.config.ts` ← `testPathIgnorePatterns: ['/node_modules/', '/inventory-service/']`
4. `.dockerignore` ← إلحاق `inventory-service/`

ثم التحقّق المطلوب: عدد ملفات `tsc --noEmit` يعود إلى **٦٥**، و`dist/main.js` موجود بعد
`nest build`، و`jest --listTests` خالٍ من أي شيء تحت `inventory-service`.
