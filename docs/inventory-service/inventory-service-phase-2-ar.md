# المرحلة ٢ — تعديلات الجذر وهيكل خدمة NestJS

**نطاق هذه المرحلة:** التعديلات الأربعة المصرَّح بها في المستودع الجذر + هيكل خدمة gRPC مستقلّة
**التاريخ:** ٨ تشرين الثاني / نوفمبر ٢٠٢٦
**السابق:** [المرحلة ٠](inventory-service-phase-0-ar.md) · [المرحلة ١](inventory-service-phase-1-ar.md)

---

## ١. تعديلات الجذر الأربعة ونتائج البوّابة

| # | الملف | التعديل |
| --- | --- | --- |
| ١ | `tsconfig.json` | `"exclude": ["node_modules", "dist", "inventory-service"]` |
| ٢ | `tsconfig.build.json` | إضافة `"inventory-service"` إلى `exclude` (دفاعي) |
| ٣ | `jest.config.ts` | `testPathIgnorePatterns: ['/node_modules/', '/inventory-service/']` |
| ٤ | `.dockerignore` | إلحاق `inventory-service` — و**لم** يُضف `proto/` لأن التطبيق الأساسي سيحتاجه |

### نتائج البوّابة بالأرقام

```
V1  tsc --showConfig -p tsconfig.json
    exclude : ['node_modules', 'dist', 'inventory-service']
    files   : 65          ← عاد إلى العدد الأصلي بالضبط
    dist included?              : False
    inventory-service included? : False

V2  npx nest build
    build exit=0
    dist/main.js     : EXISTS
    dist/src/main.js : absent (correct)

V3  jest --listTests
    \src\app.controller.spec.ts        ← لا شيء تحت inventory-service
```

البوّابة الأولى نجحت بالكامل.

---

## ٢. الملفات المُنشأة داخل `inventory-service/`

### الإعداد

```
package.json            tsconfig.json          tsconfig.build.json
tsconfig.scripts.json   nest-cli.json          buf.gen.yaml
.oxlintrc.json          .gitignore             .env.example
```

### المصدر

```
src/main.ts                                      إقلاع الخدمة كـ microservice
src/app.module.ts                                الوحدة الجذر
src/config/env.validation.ts                     التحقّق من متغيّرات البيئة
src/database/database.module.ts                  اتصال TypeORM
src/grpc/proto-path.ts                           إيجاد مجلد proto/ المشترك
src/grpc/grpc-server-extras.ts                   health + reflection
src/common/errors/domain-error.ts                أخطاء النطاق ورموزها
src/common/filters/rpc-exception.filter.ts       المرشّح العام
src/common/interceptors/logging.interceptor.ts   سجلّ منظّم لكل نداء
src/common/validation/grpc-validation.pipe.ts    ValidationPipe لـ gRPC
src/inventory/inventory.module.ts
src/inventory/inventory.controller.ts
src/inventory/inventory.service.ts               stubs (المنطق في المرحلة ٣)
src/inventory/dto/inventory-request.dto.ts       أصناف التحقّق
src/generated/inventory/v1/inventory.ts          مولَّد ومُودَع (١١٧ سطراً)
scripts/grpc-probe.ts                            بديل grpcurl للتحقّق
```

---

## ٣. القرارات الجوهرية وأسبابها

### ⚠️ انحراف ١: استحالة تثبيت كل `@nestjs/*` على رقم واحد

التعليمات طلبت تثبيت **كل** حزم `@nestjs/*` على إصدار واحد متطابق. هذا **غير ممكن
حرفياً**: الحزم لا تُصدَر بالتزامن. تحقّقتُ من npm:

| الحزمة | أحدث إصدار متاح |
| --- | --- |
| `@nestjs/common` · `core` · `microservices` · `testing` | 12.4.0 |
| `@nestjs/config` | **12.1.1** (لا يوجد 12.3.x أصلاً) |
| `@nestjs/typeorm` | **12.0.3** |
| `@nestjs/cli` · `schematics` | 12.0.12 / 12.0.13 |

**ما فعلتُه بدلاً من ذلك**، وهو ما تحميه القاعدة فعلياً:

- **العائلة المتلازمة** (`common`, `core`, `microservices`, `testing`) مثبّتة على
  **`12.3.2` بالضبط** — وهو الإصدار المثبّت في التطبيق الأساسي. خلط إصدارات هذه الحزم
  تحديداً يكسر الحقن والـ metadata.
- **الحزم المستقلّة** مثبّتة بإصدارات دقيقة بلا `^`، ومطابقة للتطبيق الأساسي:
  `config@12.0.1`, `typeorm@12.0.2`, `cli@12.0.11`, `schematics@12.0.11`.

فلا يوجد أي `^` في `package.json` كلّه: كل شيء مثبّت بدقّة.

### ⚠️ اكتشاف جوهري: `@Payload()` ليست تجميلاً — بدونها التحقّق **يُتجاوَز بصمت**

المزخرِف المولَّد `@InventoryServiceControllerMethods()` هو مزخرِف **صنف** (class
decorator). وTypeScript يُصدر `design:paramtypes` لدالّة ما فقط إذا كانت الدالّة نفسها أو
أحد وسطائها مزخرَفاً **في الشيفرة المصدرية**. ومن دون تلك الـ metadata يتلقّى
`ValidationPipe` قيمة `metatype === undefined` فيتخطّى التحقّق **من دون أي خطأ**.

لم أكتفِ بالادّعاء — أثبتُّه بتجربة: حذفتُ `@Payload()` من `reserveStock` وحدها، ثم بنيتُ
وفحصتُ المخرجات:

```
=== design:paramtypes المُصدَرة بعد حذف @Payload من reserveStock ===
__metadata("design:paramtypes", [GetStockRequestDto])      ← ما زالت تملك @Payload
__metadata("design:paramtypes", [ReleaseStockRequestDto])  ← ما زالت تملك @Payload
__metadata("design:paramtypes", [InventoryService])        ← الباني
                                   ← لا شيء لـ reserveStock
```

ثم أعدتُ تشغيل الخدمة وفحصتُها حيّاً:

```
FAIL  empty items is rejected by validation      -> code=12 (UNIMPLEMENTED)
FAIL  missing reservationId is rejected          -> code=12 (UNIMPLEMENTED)
FAIL  zero quantity is rejected                  -> code=12 (UNIMPLEMENTED)
```

أي أن المدخلات الفاسدة وصلت إلى المعالج كما لو كانت صحيحة. أعدتُ `@Payload()` فعادت
الفحوص الثلاثة إلى `code=3 (INVALID_ARGUMENT)`.

**هذا أخطر صنف من الأخطاء:** لا رسالة، لا استثناء، فقط حماية مفقودة. وثّقتُه في تعليق
داخل المتحكّم حتى لا يحذفها أحد لاحقاً ظنّاً أنها زائدة.

### قرارات أخرى

**مسار `proto/`** — الملف مشترك مع التطبيق الأساسي ولا يُنسخ داخل الحزمة، فموقعه النسبي
يختلف بين البيئات. `resolveProtoDir()` يجرّب مرشّحات بالترتيب
(`PROTO_DIR` ← `../../../proto` ← `../../proto` ← `cwd`) ويعيد أوّل مسار يحتوي الملف
فعلاً، وإلا يرمي خطأً يسرد كل ما جرّبه — أوضح بكثير من خطأ "namespace not found" الغامض
الذي يرميه proto-loader.

**دمج health proto في reflection** — `HealthImplementation.addToServer()` تسجّل الخدمة
لكن reflection لا يعرفها. بدمج تعريفها في الحزمة المُمرَّرة إلى `ReflectionService`
يستطيع grpcurl أن يسرد **ويستدعي** فحص السلامة بالاسم.

**`onLoadPackageDefinition`** — Nest يعرّفها `(pkg: any, server: any) => void`. محاولتي
الأولى بتضييق النوع إلى `never` فشلت في البناء، فاستخرجتُ النوع المطلوب من كل مكتبة بدل
تخمينه:

```ts
type HealthServer = Parameters<HealthImplementation['addToServer']>[0];
type ReflectionTarget = Parameters<ReflectionService['addToServer']>[0];
```

فإن غيّرت أي مكتبة توقيعها توقّف البناء بدل أن ينهار التشغيل.

**المعالجات ترمي `UNIMPLEMENTED`** بدل إرجاع نجاح وهمي — فالفرق يبقى ظاهراً لأي مستدعٍ،
ويسمح بالتحقّق من المرشّح والسجلّ والتحقّق end-to-end في هذه المرحلة.

**التوليد لا يدخل Docker** — `src/generated` مُودَع في Git، و`buf`/`ts-proto` في
`devDependencies` فقط. صورة الإنتاج لن تحتاجهما لا للبناء ولا للتشغيل.

### ⚠️ انحراف ٢: grpcurl غير متاح

grpcurl غير مثبّت على الجهاز ولا يملك حزمة npm (تحقّقتُ: `grpcurl` و`grpcurl-binary` غير
موجودتين). التكليف يسمح صراحةً ببديل، فكتبتُ `scripts/grpc-probe.ts` الذي يؤدّي العمليات
نفسها عبر `@grpc/grpc-js` + `@grpc/proto-loader`:

- يسرد الخدمات عبر **بروتوكول reflection الحقيقي** (مكافئ `grpcurl list`) مستعملاً
  `reflection.proto` الذي تشحنه `@grpc/reflection`.
- ينادي `grpc.health.v1.Health/Check`.
- ينادي العمليات الثلاث ومدخلات فاسدة.

يُشغَّل بـ `npm run probe`.

---

## ٤. نتيجة بوّابة المرحلة ٢ (مخرجات فعلية)

البيئة: PostgreSQL 18.3 محلية مؤقّتة على المنفذ **5434**، قاعدة `inventory`.
(Docker Desktop كان متوقّفاً؛ أُقلع في الخلفية للمرحلة ٤.)

### الإقلاع

```
[NestFactory]      Starting Nest application...
[InstanceLoader]   DatabaseModule dependencies initialized
[InstanceLoader]   TypeOrmCoreModule dependencies initialized +131ms
[GrpcServer]       Registered grpc.health.v1.Health and server reflection
[NestMicroservice] Nest microservice successfully started
```

### الفحص

```
=== reflection: list services on 127.0.0.1:50051 ===
  grpc.health.v1.Health
  inventory.v1.InventoryService
  PASS  inventory.v1.InventoryService is advertised
  PASS  grpc.health.v1.Health is advertised

=== health check ===
  PASS  overall status is SERVING -> SERVING
  PASS  inventory.v1.InventoryService status is SERVING -> SERVING

=== inventory RPCs ===
  PASS  GetStock reaches the handler    -> code=12 (UNIMPLEMENTED)
  PASS  ReserveStock reaches the handler -> code=12 (UNIMPLEMENTED)
  PASS  ReleaseStock reaches the handler -> code=12 (UNIMPLEMENTED)
  PASS  empty items is rejected          -> code=3 (INVALID_ARGUMENT) "items: items must contain at least 1 elements"
  PASS  missing reservationId is rejected -> code=3 (INVALID_ARGUMENT) "reservationId: reservationId should not be empty"
  PASS  zero quantity is rejected        -> code=3 (INVALID_ARGUMENT) "items.0.quantity: quantity must be a positive number"

================  ALL CHECKS PASSED  ================
```

### البناء والتدقيق

```
npm run proto:generate   exit=0   (117 سطراً، استيرادان فقط)
npm run build            exit=0
npm run lint             exit=0   (oxlint --type-aware، بلا تحذيرات)
npx tsc --noEmit -p tsconfig.scripts.json   exit=0
```

**بوّابة المرحلة ٢ مجتازة بالكامل.**

---

## ٥. تصحيح في أداة الفحص (لا في الخدمة)

في أول تشغيل أظهر فحص السلامة `1` بدل `SERVING`، ففشل شرطان. السبب **خطأ في أداة الفحص
لا في الخدمة**: أغفلتُ `enums: String` في خيارات proto-loader، فعاد الـ enum رقماً
(`SERVING = 1`). أضفتُ الخيار — وهو ما يفعله grpcurl — فظهر الاسم. الخدمة كانت تُجيب
بالقيمة الصحيحة منذ البداية.

---

## ٦. مخاطر وأسئلة مفتوحة

- **`DB_STATEMENT_TIMEOUT_MS` غير مُختبَر بعد.** يُمرَّر عبر `extra.statement_timeout`
  لكن لا يوجد استعلام طويل لاختباره. سأتحقّق منه في المرحلة ٣.
- **`migrations` glob يشير إلى `dist/database/migrations`** وهو فارغ الآن؛ المرحلة ٣
  تملؤه وتضيف `data-source.ts` منفصلاً لواجهة TypeORM السطرية.
- **`gracefulShutdown: true` مُفعَّل لكنه غير مُبرهَن**؛ أخطّط لإثباته في المرحلة ٤ مع
  `docker compose stop`.
- **قرار يخصّك:** الخدمة تثبّت `ts-node` لتشغيل `scripts/`. بديل أخفّ هو تصريف السكربتات
  بـ `tsc` ضمن `dist`. أبقيتُ `ts-node` لأن المرحلة ٥ تحتاج `demo:race` سريع التعديل أثناء
  المناقشة.

---

## الخطوة التالية

**المرحلة ٣** — الهجرات، والمنطق الآمن تحت التزامن (`ReserveStock` بـ UPDATE شرطي ذرّي،
الترتيب لمنع الـ deadlock، الـ idempotency، شاهدة القبر tombstone)، والـ seed.
