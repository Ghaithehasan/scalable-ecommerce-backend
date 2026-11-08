# خدمة المخزون — دليل المراجعة

**المتطلّب الثاني:** استخراج نطاق المخزون إلى خدمة مستقلّة تتواصل مع التطبيق الأساسي عبر gRPC
**التاريخ:** ٨ تشرين الثاني / نوفمبر ٢٠٢٦
**الحالة:** المراحل ٠ إلى ٥ منجزة، وكل البوّابات مجتازة عدا بنداً واحداً في المرحلة ٤
(بناء صورة التطبيق الأساسي) يفشل لسبب شبكيّ سابق لعملي — التفاصيل والأدلّة في
[تقرير المرحلة ٤](inventory-service-phase-4-ar.md) والقرار رقم ٦ أدناه.
**لم يُنفَّذ أي أمر git** — كل شيء في شجرة العمل بانتظار مراجعتك.

---

## ١. فهرس التقارير

| المرحلة | التقرير | المحتوى |
| --- | --- | --- |
| ٠ | [قراءة المشروع](inventory-service-phase-0-ar.md) | نوع معرّف المنتج، غياب عمود المخزون، مسار إنشاء الطلب، مصفوفة إعدادات الجذر، الإصدارات |
| ١ | [العقد](inventory-service-phase-1-ar.md) | ملف proto، التحقّق من سلسلة الأدوات مع Nest 12، اكتشافا `@bufbuild/protobuf` و`createMicroservice` |
| ٢ | [تعديلات الجذر والهيكل](inventory-service-phase-2-ar.md) | البوّابات الثلاث بالأرقام، هيكل الخدمة، اكتشاف `@Payload()` |
| ٣ | [قاعدة البيانات والتزامن](inventory-service-phase-3-ar.md) | الهجرات، الـ UPDATE الشرطي، ترتيب القفل، القيود، شاهدة القبر، اكتشاف ناتج `query()` |
| ٤ | [Docker والأدوات](inventory-service-phase-4-ar.md) | الصورة، compose، السكربتات، README الخدمة · **بوّابة جزئية — اقرأها** |
| ٥ | [الاختبارات والإثبات](inventory-service-phase-5-ar.md) | ٣٠ اختباراً، إثبات التسابق، اكتشاف أن مهلة gRPC لا توقف الخادم |

ويُقرأ معها [`inventory-service/README.md`](../../inventory-service/README.md): دليل
التشغيل وأوامر grpcurl وقسم **ملاحظات التكامل** للخطوة القادمة.

---

## ٢. الملفات المُنشأة والمعدَّلة، مرتّبة بالمرحلة

### تعديلات الجذر — أربعة ملفات فقط، كلّها ضمن المصرَّح به (المرحلة ٢)

| الملف | التعديل |
| --- | --- |
| `tsconfig.json` | `"exclude": ["node_modules", "dist", "inventory-service"]` |
| `tsconfig.build.json` | إضافة `"inventory-service"` إلى `exclude` (دفاعي) |
| `jest.config.ts` | `testPathIgnorePatterns: ['/node_modules/', '/inventory-service/']` |
| `.dockerignore` | إلحاق `inventory-service` — و**لم** يُضف `proto/` |

**لم يُلمَس أي ملف داخل `src/` الخاص بالتطبيق الأساسي.**

### المرحلة ١ — العقد

```
proto/inventory/v1/inventory.proto
```

### المرحلة ٢ — الهيكل

```
inventory-service/package.json          package-lock.json
inventory-service/tsconfig.json         tsconfig.build.json      tsconfig.scripts.json
inventory-service/nest-cli.json         buf.gen.yaml             .oxlintrc.json
inventory-service/.gitignore            .env.example
inventory-service/src/main.ts
inventory-service/src/app.module.ts
inventory-service/src/config/env.validation.ts
inventory-service/src/database/database.module.ts
inventory-service/src/grpc/proto-path.ts
inventory-service/src/grpc/grpc-server-extras.ts
inventory-service/src/common/errors/domain-error.ts
inventory-service/src/common/filters/rpc-exception.filter.ts
inventory-service/src/common/interceptors/logging.interceptor.ts
inventory-service/src/common/validation/grpc-validation.pipe.ts
inventory-service/src/inventory/inventory.module.ts
inventory-service/src/inventory/inventory.controller.ts
inventory-service/src/inventory/inventory.service.ts
inventory-service/src/inventory/dto/inventory-request.dto.ts
inventory-service/src/generated/inventory/v1/inventory.ts   (مولَّد ومُودَع)
inventory-service/scripts/grpc-probe.ts
```

### المرحلة ٣ — قاعدة البيانات والمنطق

```
inventory-service/src/inventory/entities/stock.entity.ts
inventory-service/src/inventory/entities/reservation.entity.ts
inventory-service/src/inventory/entities/reservation-item.entity.ts
inventory-service/src/database/data-source.ts
inventory-service/src/database/migrations/1762500000000-CreateInventorySchema.ts
inventory-service/src/database/seed.ts
inventory-service/src/common/database/postgres-errors.ts
```

### المرحلة ٤ — Docker والأدوات

```
inventory-service/Dockerfile
inventory-service/Dockerfile.dockerignore
inventory-service/docker-compose.yml
inventory-service/src/healthcheck.ts
inventory-service/README.md
```

### المرحلة ٥ — الاختبارات

```
inventory-service/jest.config.ts        tsconfig.spec.json
inventory-service/test/grpc-test-harness.ts
inventory-service/test/inventory.e2e-spec.ts
inventory-service/test/race.e2e-spec.ts
inventory-service/test/deadline.e2e-spec.ts
inventory-service/test/enable-artificial-delay.ts
inventory-service/scripts/race-demo.ts
```

### التقارير

```
docs/inventory-service/inventory-service-phase-0-ar.md  .. phase-5-ar.md
docs/inventory-service/README-review-ar.md              (هذا الملف)
```

> `docs/inventory-service-phase-{0,1}-ar.md` نُقلا إلى `docs/inventory-service/` كما طلبت.

---

## ٣. الانحرافات عن التكليف — مجمّعة

| # | الانحراف | السبب |
| --- | --- | --- |
| ١ | **تثبيت كل `@nestjs/*` على رقم واحد مستحيل** | الحزم لا تُصدَر بالتزامن: `@nestjs/config` أقصاه 12.1.1 و`@nestjs/typeorm` أقصاه 12.0.3 بينما النواة 12.4.0. **البديل:** العائلة المتلازمة (`common`/`core`/`microservices`/`testing`) على `12.3.2` بالضبط — مطابقة للتطبيق الأساسي — والبقية بإصدارات دقيقة بلا `^`. لا يوجد `^` واحد في الملف. |
| ٢ | **استثناء `tsconfig.build.json` دفاعي لا حاسم** | أثبتُّ في المرحلة ٠ أن `include: ["src"]` يكفي وحده: البناء أنتج `dist/main.js` حتى مع ملف TypeScript مكسور داخل `inventory-service`. أضفتُه كما طلبت، مع توضيح أنه توثيق نيّة لا إصلاح. |
| ٣ | **grpcurl غير متاح** | غير مثبّت ولا يملك حزمة npm. التكليف يسمح بالبديل، فكتبتُ `scripts/grpc-probe.ts` الذي يستعمل **بروتوكول reflection الحقيقي**. وأوامر grpcurl الجاهزة موثّقة في README لمن يملكها. |
| ٤ | **لم أستعمل testcontainers** | سحب الصور على هذا الجهاز بطيء بشكل قاسٍ (١٥ ميغابايت في ١١ دقيقة). استعملتُ قاعدة البيانات عبر متغيّرات `DB_*` كما يسمح التكليف. |
| ٥ | **أُضيفت تعليقات إلى ملف proto** | لم يتغيّر أي اسم حقل أو رقم أو نوع — العقد على السلك مطابق حرفياً. وافقتَ على إبقائها. |
| ٦ | **اعتماد `dotenv` إضافي** | واجهة TypeORM السطرية والـ seed تعمل خارج Nest، فلا يحمّل `ConfigModule` ملف `.env` نيابةً عنهما. |
| ٧ | **`src/database/seed.ts` لا `scripts/seed.ts`** | ليُصرَّف ضمن `dist`: صورة الإنتاج لا تحمل أي أدوات TypeScript، والحاوية تزرع نفسها بـ `node dist/database/seed.js`. |
| ٨ | **`Dockerfile.dockerignore` لا `.dockerignore`** | سياق البناء هو جذر المستودع، و`.dockerignore` الجذري يستثني `inventory-service` بالكامل — فكان سيفرّغ سياق البناء. BuildKit يقرأ `<dockerfile>.dockerignore` أولاً. |
| ٩ | **تقسية `npm ci` في Dockerfile الخدمة** (cache mount + retries + تتابع المرحلتين) | الشبكة على هذا الجهاز تقطع الاتصال أثناء التثبيت (`ECONNRESET`)، ففشل البناء ثلاث مرّات. التقسية ليست التفافاً على فحص بل إصلاح هندسي صحيح، وبعدها نجح البناء من أول محاولة. |

---

## ٤. خمسة أخطاء كان كلٌّ منها سيُسبّب عطلاً حقيقياً

هذه أهم ما في العمل كلّه، ولم يكشف أيّاً منها إلا التشغيل الفعلي:

| # | الاكتشاف | ما كان سيحدث |
| --- | --- | --- |
| ١ | **`query()` يعيد `[rows, affected]` لا مصفوفة صفوف** في TypeORM 1.1.2 | `result.length` تساوي ٢ دائماً → كل حجز مرفوض يُقرأ ناجحاً → **بيع زائد صامت** |
| ٢ | **`@Payload()` إلزامية لتوليد `design:paramtypes`** | `ValidationPipe` يتلقّى `metatype === undefined` فيتخطّى التحقّق **بلا أي رسالة** — أثبتُّه بحذفها ورؤية المدخلات الفاسدة تمرّ |
| ٣ | **`@bufbuild/protobuf` اعتماد وقت تشغيل خفيّ** | `npm ci --omit=dev` كان سيُسقطها → انهيار الحاوية بـ `MODULE_NOT_FOUND` |
| ٤ | **`createMicroservice` بوسيطين في Nest 12** | `logger` كوسيط ثالث يفشل بـ `TS2554` |
| ٥ | **مهلة gRPC لا توقف عمل الخادم** | التطبيق قد يظنّ أن لا شيء حدث بينما الوحدات حُجزت فعلاً → **تسرّب مخزون مع كل انقطاع** — وهذا جوهر سبب وجود التعويض وشاهدة القبر |

---

## ٥. ما يحتاج قراراً منك

1. **معرّفات المنتجات في الـ seed.** استعملتُ `"1".."8"` لأن التطبيق الأساسي لا يملك
   seed. إن كانت معرّفات كتالوجك الحقيقية مختلفة، عدّل `SEED_ROWS` في
   [`src/database/seed.ts`](../../inventory-service/src/database/seed.ts).
   ولن أقرأ قاعدة التطبيق الأساسي تلقائياً أبداً — ذلك يهدم حدود قاعدة-لكل-خدمة.

2. **`ts-node` اعتماد تطوير.** تحتاجه السكربتات (`probe`, `seed`, `demo:race`). البديل
   تصريفها ضمن `dist`. أبقيتُها لأن `demo:race` يفيد تعديله سريعاً أثناء المناقشة.
   (ليست في صورة الإنتاج.)

3. **الاختبارات الثلاثة الفاشلة في `test/app.e2e-spec.ts`** ما زالت كما هي — سابقة لعملي
   ومن المتطلّب الأول، ومن منطقة غيث. أكّدتُ أن عددها لم يتغيّر: `3 failed, 74 passed`.
   هل أصلحها في فرع منفصل؟

4. **`DB_STATEMENT_TIMEOUT_MS` غير مُبرهَن.** مُمرَّر عبر `extra.statement_timeout` لكن لا
   يوجد استعلام بطيء بما يكفي لتفعيله. شبكة أمان غير مُختبَرة.

5. **المنافذ:** الخدمة على `50051` وقاعدتها على `5434`. إن تعارضت مع شيء عندك فغيّرها من
   `.env`.

6. **⚠️ القرار الأهم: إذن بتعديل `Dockerfile` الجذر.** بناء صورة التطبيق الأساسي يفشل
   بـ `ECONNRESET` أثناء `npm ci` — **وهو فشل سابق لعملي وبيئيّ**، أثبتُّ ذلك في
   [تقرير المرحلة ٤](inventory-service-phase-4-ar.md#) بخمسة أدلّة. السبب أن الملف يشغّل
   `npm ci` مرّتين بالتوازي على وصلة ضعيفة. العلاج ثلاثة أسطر — نفس ما طبّقتُه على
   Dockerfile الخدمة فنجح فوراً — لكن `Dockerfile` الجذر **خارج قائمة التعديلات المصرَّح
   بها**، فلم ألمسه. هل تأذن؟

---

## ٦. كيف تراجع بسرعة

```bash
# التطبيق الأساسي لم يتأثّر
npx nest build && ls dist/main.js
npm run lint
npm test            # 1 passed
npm run test:e2e    # 74 passed, 3 failed (نفس إخفاقات المتطلّب الأول)

# الخدمة
cd inventory-service
npm install
npm run build && npm run lint
docker compose up --build     # أو: npm run migration:run && npm run seed && npm run start:prod
npm test                      # 30 passed
npm run probe                 # فحص يدوي لكل العمليات
npm run demo:race -- 50       # عرض التسابق
```

---

## ٧. الخطوة التالية

ربط التطبيق الأساسي بالخدمة. التفاصيل كاملةً في قسم **"Next step: integration notes"**
في [`inventory-service/README.md`](../../inventory-service/README.md)، وملخّصها:

- الحجز **قبل** فتح معاملة الطلب.
- `ReleaseStock` تعويضاً عند أي فشل بعد حجز ناجح — بما في ذلك انتهاء المهلة.
- حلقة إعادة المحاولة على `order_number` تعيد **المعاملة فقط** بنفس `reservationId`، ولا
  تُعيد الحجز أبداً.
- deadline على كل نداء.
- ربط رموز gRPC بـ HTTP: `reserved=false` → **409** مع النواقص · `NOT_FOUND` → 404 ·
  `INVALID_ARGUMENT` → 400 · `UNAVAILABLE`/`DEADLINE_EXCEEDED` → 503.
- `String(product.id)` عند الإرسال.
- `COPY proto ./proto` في Dockerfile الجذر، و`@nestjs/microservices` في `package.json`
  الخاص بالتطبيق الأساسي.
