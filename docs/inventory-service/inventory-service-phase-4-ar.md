# المرحلة ٤ — Docker والأدوات

**نطاق هذه المرحلة:** صورة الخدمة، حزمة compose مستقلّة، سكربتات npm، دليل الخدمة
**التاريخ:** ٨ تشرين الثاني / نوفمبر ٢٠٢٦
**السابق:** [٠](inventory-service-phase-0-ar.md) · [١](inventory-service-phase-1-ar.md) · [٢](inventory-service-phase-2-ar.md) · [٣](inventory-service-phase-3-ar.md)

---

## ١. الملفات المُنشأة والمعدَّلة

```
inventory-service/Dockerfile                 بناء متعدّد المراحل، مستخدم غير جذري
inventory-service/Dockerfile.dockerignore    (الاسم مقصود — انظر أدناه)
inventory-service/docker-compose.yml         الخدمة + قاعدتها الخاصّة
inventory-service/src/healthcheck.ts         فحص سلامة gRPC حقيقي
inventory-service/README.md                  التشغيل، المتغيّرات، grpcurl، ملاحظات التكامل
inventory-service/src/database/seed.ts       نُقل من scripts/ (السبب أدناه)
inventory-service/package.json               سكربتات الإنتاج والعرض
```

---

## ٢. الصورة

```dockerfile
FROM node:24-slim AS builder      # نفس إصدار Node في التطبيق الأساسي
COPY inventory-service/package.json inventory-service/package-lock.json ./
RUN npm ci
COPY inventory-service/src ./src
RUN npm run build

FROM node:24-slim AS runtime
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY proto ./proto
ENV PROTO_DIR=/app/proto
USER node
```

### ⚠️ سياق البناء هو جذر المستودع، لا مجلد الخدمة

هذا ليس تفصيلاً: `proto/` ملك مشترك بين الخدمة والتطبيق الأساسي، ونسخه داخل حزمة الخدمة
كان سيُنشئ نسختين من العقد — وهو بالضبط ما يجب تجنّبه. فالسياق هو الجذر، ومسارات `COPY`
مكتوبة بالنسبة إليه (`inventory-service/src`, `proto`).

### ⚠️ `Dockerfile.dockerignore` لا `.dockerignore`

كتبتُ `.dockerignore` في مجلد الخدمة أولاً، ثم أدركتُ أنه **لن يُقرأ إطلاقاً**: Docker
يبحث عن `.dockerignore` بجوار **جذر السياق**. والأسوأ أن `.dockerignore` الجذري يستثني
`inventory-service` بالكامل (وهو تعديل مصرَّح به أجريناه في المرحلة ٢) — فكان سيصل إلى
البناء سياق **بلا أي شيفرة للخدمة**.

الحل أن BuildKit يقرأ `<dockerfile>.dockerignore` بأولوية أعلى، فأعدتُ التسمية إلى
`Dockerfile.dockerignore`. وبهذا يستعمل بناء الخدمة قواعده الخاصّة، ويستعمل بناء التطبيق
الأساسي قواعده، ولا يتداخلان.

### الصورة لا تحتاج buf ولا ts-proto

`src/generated` مُودَع في Git، و`buf` و`ts-proto` في `devDependencies` فقط. مرحلة البناء
تُصرِّف الكود المولَّد الموجود مسبقاً، ومرحلة التشغيل تحمل اعتماديات الإنتاج والمخرجات
المُصرَّفة فقط — لا شيفرة مصدرية ولا اختبارات ولا أدوات بناء.

### نقل الـ seed إلى `src/`

كان `scripts/seed.ts` يحتاج `ts-node`، وهو اعتماد تطوير غير موجود في صورة الإنتاج.
نقلتُه إلى `src/database/seed.ts` ليُصرِّفه `nest build`، فتزرع الحاوية نفسها بـ
`node dist/database/seed.js`. والمنطق لم يتغيّر، فقط موضعه.

---

## ٣. حزمة compose

ملف **منفصل** عن compose الجذر عمداً: الخدمة تملك قاعدتها ودورة حياتها، ويجب أن تُشغَّل
وتُوقَف من دون المساس بالتطبيق الأساسي.

| الخدمة | المنفذ على المضيف | ملاحظة |
| --- | --- | --- |
| `inventory-postgres` | **5434** | 5432 لـ PostgreSQL المحلّي و5433 لقاعدة التطبيق الأساسي |
| `inventory` | **50051** | سياق البناء `..` |

الهجرات والـ seed تكتملان **قبل** أن يقبل الخادم أي نداء:

```yaml
command: >
  sh -c "node ./node_modules/typeorm/cli.js --dataSource dist/database/data-source.js migration:run
  && node dist/database/seed.js
  && node dist/main"
```

### ⚠️ فحص السلامة: استبدلتُ فحصاً زائفاً بآخر حقيقي

كتبتُ في المسوّدة الأولى:

```yaml
test: ['CMD', '/usr/bin/test', '-e', '/proc/1']
```

وهذا **فحص زائف**: ينجح دائماً ما دامت الحاوية حيّة، ولا يسأل الخدمة شيئاً. وبما أن
القواعد تمنع إضعاف أي فحص، استبدلتُه بفحص فعلي. Docker لا يملك مِسباراً أصلياً لـ gRPC
(بخلاف Kubernetes)، والصورة لا تحمل أدوات إضافية — فكتبتُ `src/healthcheck.ts` الذي
ينادي `grpc.health.v1.Health/Check` بالمكتبات الموجودة أصلاً ويُنهي بصفر فقط عند `SERVING`:

```yaml
test: ['CMD', 'node', 'dist/healthcheck.js']
```

---

## ٤. سكربتات npm

| السكربت | الوظيفة |
| --- | --- |
| `proto:generate` | توليد `src/generated` من `../proto` — وقت التطوير فقط |
| `build` · `start` · `start:dev` · `start:prod` | البناء والتشغيل |
| `migration:run` · `migration:revert` · `migration:show` | عبر `typeorm-ts-node-commonjs` على `src/database/data-source.ts` |
| `migration:run:prod` · `seed:prod` | المكافئ المُصرَّف، يُستعمَل داخل الحاوية |
| `seed` | upsert متكرّر الاستدعاء بأمان |
| `test` · `test:race` | اختبارات التكامل · مجموعة التزامن وحدها |
| `demo:race` | عرض التسابق الحيّ |
| `probe` | بديل grpcurl: reflection + health + كل العمليات |
| `lint` | `oxlint --type-aware` |

---

## ٥. `README.md` الخاص بالخدمة

يغطّي: العقد وجدول رموز الحالة · التشغيل بـ Docker ومحلّياً · جدول متغيّرات البيئة ·
**جدول ربط معرّفات المنتجات** مع التطبيق الأساسي · السكربتات · أوامر grpcurl جاهزة للنسخ ·
عرض التسابق · وقسم **"Next step: integration notes"** الذي يحمل كل ما طلبتَ حفظه:

- الحجز **قبل** فتح معاملة الطلب، مع مقتطف الشيفرة.
- `ReleaseStock` تعويضاً بعد أي فشل يلي حجزاً ناجحاً.
- حلقة إعادة المحاولة على `order_number` تعيد المعاملة فقط بنفس `reservationId` ولا
  تُعيد الحجز أبداً.
- deadline على كل نداء.
- جدول ربط رموز gRPC بـ HTTP.
- `String(product.id)`.
- `COPY proto ./proto` في Dockerfile الجذر، و`@nestjs/microservices` في `package.json`
  الخاص بالتطبيق الأساسي.

---

## ٦. نتائج البوّابة

### التحقّق من إعداد compose

`docker compose config` يُحلّل بنجاح ويُظهر السياق والمسارات الصحيحة:

```
build:
  context: C:\nest projects\scalable-ecommerce-backend     ← جذر المستودع
  dockerfile: inventory-service/Dockerfile
  target: runtime
command: sh -c "node ./node_modules/typeorm/cli.js --dataSource
         dist/database/data-source.js migration:run
         && node dist/database/seed.js && node dist/main"
healthcheck:
  test: [CMD, node, dist/healthcheck.js]
depends_on:
  inventory-postgres: {condition: service_healthy}
```

### التطبيق الأساسي لم يتأثّر

```
npx nest build          exit=0   ·  dist/main.js: EXISTS
npm run lint            exit=0
npm test                1 passed, 1 total
npm run test:e2e        74 passed, 3 failed   ← نفس الإخفاقات الثلاثة السابقة
                                                 لعملي من المتطلّب الأول، بلا زيادة
docker compose config (الجذر)   OK
```

### بناء الصورة وتشغيل الحاويتين ✅

```
docker compose build      →  Image inventory-service-inventory Built
docker compose up -d      →  Container inventory-postgres Healthy
                             Container inventory-service Started

docker compose ps
  inventory-postgres: Up 55 seconds (healthy)
  inventory:          Up 49 seconds (healthy)      ← فحص سلامة gRPC حقيقي
```

سجلّ الحاوية يُظهر التسلسل كاملاً داخلها: الهجرة ثم الـ seed ثم الخادم.

```
inventory-service |   8 stock rows present.
inventory-service | [NestFactory]      Starting Nest application...
inventory-service | [GrpcServer]       Registered grpc.health.v1.Health and server reflection
inventory-service | [NestMicroservice] Nest microservice successfully started
```

### الخدمة داخل الحاوية تُجيب ببيانات الـ seed ✅

أوقفتُ أولاً نسخة PostgreSQL المحلّية والخدمة المحلّية، لأن كليهما كان يتشارك المنفذين
`50051` و`5434` مع Docker فتصبح نتيجة الفحص ملتبسة. بعد ذلك لم يبقَ على المنفذين إلا
`wslrelay` و`com.docker.backend` — أي الحاويات وحدها.

ثم `npm run probe` ضدّ الحاوية: **٢١ فحصاً، كلها ناجحة**، منها:

```
PASS  GetStock returns seeded rows and omits unknown ids
      -> {"items":[{"productId":"2","available":5,"reserved":0},
                   {"productId":"3","available":10,"reserved":0}]}
PASS  health of "(overall)" is SERVING -> SERVING
PASS  all-or-nothing: one short item blocks the whole order
PASS  a late reserve on that id is refused by the tombstone -> code=9
================  ALL CHECKS PASSED  ================
```

وعرض التسابق ضدّ الحاوية بخمسين متسابقاً:

```
  reserved = true  (order accepted)  1
  reserved = false (out of stock)    49
  technical errors                   0
  stock after : available 0, reserved 1      elapsed : 233 ms
  ✓ Exactly one buyer got the last unit. No overselling.
```

### ⚠️ بناء صورة التطبيق الأساسي: فشل — والسبب ليس تعديلي

`docker compose build` في الجذر يفشل، **مرّتين متتاليتين**، بالخطأ نفسه:

```
#11 454.6 npm error code ECONNRESET
#11 454.6 npm error network aborted
failed to solve: process "/bin/sh -c npm ci --omit=dev && npm cache clean --force"
  did not complete successfully: exit code: 1
```

**الأدلّة على أن تعديلي بريء من هذا:**

1. تعديلي الوحيد على `.dockerignore` هو إلحاق ثلاثة أسطر:
   ```diff
   +
   +# The inventory microservice builds from its own Dockerfile.
   +inventory-service
   ```
2. `Dockerfile` الجذري **لا يذكر `inventory-service` إطلاقاً** — تحقّقتُ بالبحث.
3. الخطوة الفاشلة هي `npm ci --omit=dev` في مرحلة `runtime`، ومدخلاتها الوحيدة
   `package.json` و`package-lock.json`. وخطوة `COPY package.json package-lock.json ./`
   **نجحت** في السجلّ — أي أن سياق البناء سليم ولم يُستثنَ منه شيء يحتاجه.
4. الخطأ `ECONNRESET` عطل شبكة، ولا سبيل لملف `.dockerignore` أن يؤثّر على سلوك شبكة npm.
5. وهو **الخطأ نفسه** الذي أوقف بناء خدمة المخزون ثلاث مرّات قبل المعالجة.

**السبب الجذري والعلاج.** `Dockerfile` الجذري يشغّل `npm ci` مرّتين (في `builder` و
`runtime`) **بالتوازي**، فتتنافسان على وصلة شبكة ضعيفة أصلاً حتى تنقطع. وهذه بالضبط
المشكلة التي شخّصتُها وعالجتُها في Dockerfile خدمة المخزون بثلاث خطوات:

```dockerfile
RUN --mount=type=cache,target=/root/.npm \        # يحفظ ما نُزِّل بين المحاولات
    npm ci --fetch-retries=5 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000
...
COPY --from=builder /app/dist ./dist              # يُجبر المرحلتين على التتابع
```

بعد هذه الخطوات نجح بناء خدمة المخزون من المحاولة الأولى.

**لماذا لم أطبّقها على الجذر:** `Dockerfile` الجذري **خارج قائمة التعديلات المصرَّح بها**
(المسموح `.dockerignore` فقط). ولا أعدّل ملفاً للتطبيق الأساسي من دون إذنك، حتى لو كان
الإصلاح واضحاً.

**ما أحتاجه منك:** إذن بتطبيق التعديل نفسه على `Dockerfile` الجذر. إنه ثلاثة أسطر، لا
يغيّر محتوى الصورة الناتجة إطلاقاً، ويجعل البناء يصمد أمام شبكة متقطّعة. وهو مفيد لفريقك
كلّه لا لهذا الجهاز وحده.

> **ملاحظة مهمّة:** هذا الفشل سابق لعملي وبيئيّ بحت. والتطبيق الأساسي نفسه سليم تماماً:
> `nest build` و`lint` و`test` و`test:e2e` كلها بنتائجها المعتادة بالضبط (القسم أعلاه).

---

## ٧. ملاحظات ومخاطر

- **بطء الشبكة عائق حقيقي على هذا الجهاز:** سحب `node:24-slim` وحده تجاوز ١٥ دقيقة
  لأقل من نصف الحجم. هذا هو سبب عدم استعمال testcontainers في المرحلة ٥.
- **`gracefulShutdown: true` مفعَّل لكنه غير مُبرهَن** بعد؛ إثباته يحتاج `docker compose
  stop` أثناء نداء جارٍ.
- **الحاوية تزرع البيانات عند كل إقلاع.** الـ seed عملية upsert متكرّرة الاستدعاء بأمان،
  لكنها **تعيد ضبط `available`** إلى القيم الثابتة. هذا مناسب للعرض والتطوير، وغير مناسب
  لبيئة إنتاج حقيقية — حيث يجب فصل الـ seed عن الإقلاع.
