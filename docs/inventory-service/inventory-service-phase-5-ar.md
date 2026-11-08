# المرحلة ٥ — الاختبارات والإثبات

**نطاق هذه المرحلة:** اختبارات تكامل عبر عميل gRPC حقيقي، إثبات التسابق، سكربت العرض الحيّ
**التاريخ:** ٨ تشرين الثاني / نوفمبر ٢٠٢٦
**السابق:** [٠](inventory-service-phase-0-ar.md) · [١](inventory-service-phase-1-ar.md) · [٢](inventory-service-phase-2-ar.md) · [٣](inventory-service-phase-3-ar.md) · [٤](inventory-service-phase-4-ar.md)

---

## ١. الملفات المُنشأة

```
jest.config.ts                      تهيئة Jest (عامل واحد، مهلة 60 ثانية)
tsconfig.spec.json                  إعداد TypeScript للاختبارات
test/grpc-test-harness.ts           إقلاع الخدمة الحقيقية + عميل gRPC حقيقي
test/inventory.e2e-spec.ts          19 اختباراً للسلوك
test/race.e2e-spec.ts               7 اختبارات للتزامن
test/deadline.e2e-spec.ts           4 اختبارات للمهل
test/enable-artificial-delay.ts     وحدة تأثير جانبي (شرحها أدناه)
scripts/race-demo.ts                عرض التسابق الحيّ للمناقشة
```

---

## ٢. كيف تعمل الاختبارات

كل اختبار **يُقلع الخدمة فعلياً وينادي عبر الشبكة** — لا استدعاء مباشر لـ
`InventoryService`. السبب أن النقل، والمزخرِف المولَّد، وValidationPipe، والمعترض،
ومرشّح الاستثناءات كلّها جزء من السلوك الذي نتحقّق منه، والاستدعاء المباشر لا يمرّ بأيٍّ
منها.

```ts
const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
const app = moduleRef.createNestMicroservice<MicroserviceOptions>({ transport: Transport.GRPC, ... });
await app.listen();
// ثم عميل @grpc/grpc-js حقيقي على المنفذ نفسه
```

### ⚠️ انحراف: لم أستعمل testcontainers

التكليف خيّرني بين testcontainers وقاعدة compose عبر متغيّر بيئة. اخترتُ **الثانية**،
والسبب قابل للقياس: سحب صور Docker على هذا الجهاز بطيء جداً — صورة `node:24-slim` وحدها
أخذت أكثر من ١١ دقيقة لتنزيل ١٥ ميغابايت من ٥١. مع testcontainers كان كل تشغيل للاختبارات
رهينة هذا البطء.

الاختبارات تقرأ الاتصال من متغيّرات `DB_*` المعتادة، فتعمل مع قاعدة compose أو أي قاعدة
أخرى بتغيير `.env` وحده. التشغيل هنا تمّ على PostgreSQL 18.3 على المنفذ 5434.

**العامل الواحد مقصود** (`maxWorkers: 1`): العمّال المتوازون سيتنافسون على نفس صفوف
المخزون وعلى نفس المنافذ.

---

## ٣. إثبات التسابق

```ts
await setStock(PRODUCT, 1);               // وحدة واحدة
const attempts = Array.from({ length: 50 }, (_, i) =>
  client.reserveStock(`race-${RUN}-${round}-${i}`, [{ productId: PRODUCT, quantity: 1 }]),
);
const results = await Promise.all(attempts);
expect(errors).toHaveLength(0);           // النفاد ليس خطأً تقنياً
expect(granted).toHaveLength(1);          // واحد بالضبط
expect(refused).toHaveLength(49);
expect(await readStock(PRODUCT)).toEqual({ available: 0, reserved: 1 });
```

يُنفَّذ **٥ جولات متتالية** لأن تسابقاً ينجح مرّة قد يكون محظوظاً بالجدولة، والقفل الصحيح
أحياناً ليس صحيحاً.

ويضاف إليه اختباران:

- **عشرون طلباً بثلاث وحدات على مخزون ١٠** → ينجح ٣ بالضبط، ويبقى `available 1, reserved 9`.
- **ثلاثون طلباً على منتجين بترتيبين متعاكسين** (١٥ أماماً و١٥ خلفاً) → لا خطأ تقني واحد،
  وينجح ٢٠ بالضبط. هذا هو اختبار الـ deadlock: من دون ترتيب القفل كانت المجموعتان ستتعلّقان.

---

## ٤. ⚠️ خطأ حقيقي كشفه تشغيل الاختبارات منفردةً

نجحت مجموعة التسابق ضمن التشغيل الكامل، ثم **فشلت عند تشغيلها وحدها**:

```
● round 5: exactly one of 50 simultaneous reservations wins the last unit
  Expected length: 1
  Received length: 2
```

التشخيص: معرّفات الحجز كانت ثابتة (`race-1-0` … `race-5-49`). وفي التشغيل الثاني على
**نفس قاعدة البيانات**، صفّ الحجز الفائز من التشغيل السابق ما زال موجوداً، فقاعدة
الـ idempotency تُجيب عليه `reserved = true` من دون أن تمسّ المخزون — ثم يفوز واحد جديد
فعلياً بالوحدة. المجموع: فائزان.

**الخدمة كانت على حقّ تماماً؛ التجهيزة هي التي كذبت.** هذا بالضبط ما تَعِد به الـ
idempotency: إعادة إرسال نفس المعرّف لا تحجز مرّتين.

الإصلاح: بادئة فريدة لكل تشغيل، مع تنظيف ذاتي في `afterAll`. ولم أُضعف أي شرط — بقي
`granted === 1` كما هو. وبعد الإصلاح نجحت المجموعة في تشغيلين متتاليين على القاعدة نفسها.

---

## ٥. ⚠️ اكتشاف جوهري: مهلة gRPC لا توقف عمل الخادم

عند كتابة اختبارات المهل فشل اختبار «ينجح إذا أمهله العميل وقتاً كافياً»: توقّع
`available 8, reserved 2` لكنه وجد `available 3, reserved 7`.

السبب ليس عيباً في التجهيزة بل **حقيقة في بروتوكول gRPC**: الـ deadline استسلامٌ من جهة
**العميل** فقط. الخادم لا يلتزم بإلغاء العمل، وهذه الخدمة لا تُلغيه. فالنداءات التي
انتهت مهلتها في الاختبارين السابقين **أكملت عملها على الخادم بعد ذلك** وحجزت وحداتها،
فأفسدت الاختبار التالي.

هذا الاكتشاف ليس عقبة بل **جوهر سبب وجود آلية التعويض كلّها**، فأفردتُ له اختباراً
صريحاً بدل إخفائه:

```ts
it('reserves anyway after the client gave up, which is why compensation is required', ...)
```

يُثبت الاختبار التسلسل الكامل:

1. نداء بمهلة ٣٠٠ms على خدمة تتأخّر ١٥٠٠ms → العميل يتلقّى `DEADLINE_EXCEEDED`.
2. الانتظار حتى ينهي الخادم عمله → المخزون **فعلاً** صار `available 7, reserved 3`.
3. التعويض بـ `ReleaseStock` بنفس المعرّف → يعود `available 10, reserved 0`.

**الخلاصة للتطبيق الأساسي:** مهلة منتهية **لا تعني** أن شيئاً لم يحدث. فبعد أي فشل يلي
نداء حجز — بما في ذلك انتهاء المهلة — يجب إرسال `ReleaseStock` بنفس المعرّف. وهذا ما
توجد شاهدة القبر وقواعد الـ idempotency لجعله آمناً.

وفُصلت الاختبارات على منتجات مستقلّة لكل حالة، لأن النداء المتروك قد يهبط لاحقاً ويغيّر
مخزوناً يفحصه اختبار آخر.

### عقبة تقنية ثانية في نفس المجموعة

ضبط `process.env.INVENTORY_ARTIFICIAL_DELAY_MS` داخل `beforeAll` **لم يكن له أثر**.
السبب أن `ConfigModule.forRoot()` يقرأ `.env` لحظة استيراد `src/app.module.ts`، وهو
استيراد يسبق `beforeAll`. وقرأتُ مصدر `@nestjs/config` للتأكّد:

```js
config = options.override ? { ...process.env, ...config } : { ...config, ...process.env };
```

أي أن `process.env` **يغلب** ملف `.env` — المشكلة توقيت لا أولوية. الحل وحدة تأثير جانبي
`test/enable-artificial-delay.ts` تُستورَد **قبل** أي شيء يجرّ `AppModule`.

---

## ٦. نتائج البوّابة (مخرجات فعلية)

### المجموعة الكاملة

```
Test Suites: 3 passed, 3 total
Tests:       30 passed, 30 total
```

| المجموعة | العدد | التغطية |
| --- | --- | --- |
| `inventory.e2e-spec.ts` | 19 | القراءة، الحجز، النقص، كل-أو-لا-شيء، النواقص المتعدّدة، idempotency، شاهدة القبر، كل رموز الخطأ |
| `race.e2e-spec.ts` | 7 | ٥ جولات تسابق + الشراء بالجملة + ترتيب القفل |
| `deadline.e2e-spec.ts` | 4 | `DEADLINE_EXCEEDED`، عدم القفل أثناء التأخير، النجاح بمهلة كافية، التعويض |

### التسابق ٥/٥ وغير متقلّب

```
تشغيل ١: Tests: 7 passed, 7 total
تشغيل ٢: Tests: 7 passed, 7 total   (على نفس قاعدة البيانات)
```

والمجموعة الكاملة نُفِّذت مرّتين متتاليتين: `26 passed` ثم `26 passed` (قبل إضافة مجموعة
المهل)، ثم `30 passed` بعدها.

### سكربت العرض — ٥٠ متسابقاً

```
  ┌─────────────────────────────────────────────────────────┐
  │  RACE DEMONSTRATION: one unit, many simultaneous buyers  │
  └─────────────────────────────────────────────────────────┘

  server      : 127.0.0.1:50051
  product     : "1"
  stock before: available 1, reserved 0
  callers     : 50 simultaneous ReserveStock calls

  result
  ────────────────────────────────  ─────
  reserved = true  (order accepted)  1
  reserved = false (out of stock)    49
  technical errors                   0

  stock after : available 0, reserved 1
  elapsed     : 236 ms

  winner      : 72972e77-1a09-446a-8251-d216f47e6418

  ✓ Exactly one buyer got the last unit. No overselling.
```

وبعشرين متسابقاً: `1 granted / 19 refused / 0 errors`، `available 0, reserved 1`،
‏239ms. السكربت يُنهي بـ exit code غير صفري لو اختلّ أي رقم، فلا يمكن أن «ينجح» شكلياً.

### التدقيق

```
npm run lint                          exit=0
npx tsc --noEmit -p tsconfig.spec.json exit=0
```

**بوّابة المرحلة ٥ مجتازة.**

---

## ٧. ملاحظات

- `scripts/race-demo.ts` يتّصل بقاعدة البيانات مباشرةً ليعيد ضبط المنتج إلى وحدة واحدة
  قبل العرض، لذا يجب تشغيله حيث تكون `DB_*` صحيحة. ويقبل وسيطين: عدد المتسابقين والعنوان،
  فيمكن توجيهه إلى الخدمة داخل Docker.
- اختبارات المهل تستغرق ~١١ ثانية لأنها تنتظر التأخير الاصطناعي عمداً.
- لم تُختبر `DB_STATEMENT_TIMEOUT_MS` بعد: لا يوجد استعلام بطيء بما يكفي لتفعيلها. ما زالت
  شبكة أمان غير مُبرهَنة.
