# المرحلة ٣ — قاعدة البيانات والمنطق الآمن تحت التزامن

**نطاق هذه المرحلة:** الهجرات، كيانات المخزون، منطق الحجز والتحرير، الـ seed
**التاريخ:** ٨ تشرين الثاني / نوفمبر ٢٠٢٦
**السابق:** [٠](inventory-service-phase-0-ar.md) · [١](inventory-service-phase-1-ar.md) · [٢](inventory-service-phase-2-ar.md)

---

## ١. الملفات المُنشأة والمعدَّلة

### جديدة

```
src/inventory/entities/stock.entity.ts
src/inventory/entities/reservation.entity.ts
src/inventory/entities/reservation-item.entity.ts
src/database/data-source.ts                       لواجهة TypeORM السطرية والـ seed
src/database/migrations/1762500000000-CreateInventorySchema.ts
src/common/database/postgres-errors.ts            رموز SQLSTATE + قراءة ناتج query
scripts/seed.ts
```

### معدَّلة

```
src/inventory/inventory.service.ts   المنطق الحقيقي بدل الـ stubs
src/inventory/inventory.module.ts    تسجيل الكيانات الثلاثة
scripts/grpc-probe.ts                فحوص السلوك الحقيقي بدل UNIMPLEMENTED
package.json                         migration:run / revert / show / seed + dotenv
```

---

## ٢. المخطّط

| الجدول | الأعمدة | القيود |
| --- | --- | --- |
| `stock` | `product_id` TEXT PK · `available` INT · `reserved` INT · `updated_at` | `available >= 0` · `reserved >= 0` |
| `reservations` | `id` TEXT PK · `status` TEXT · `created_at` · `updated_at` | `status IN ('RESERVED','RELEASED')` |
| `reservation_items` | `reservation_id` FK · `product_id` · `quantity` INT | PK مركّب · `quantity > 0` · FK ON DELETE CASCADE |

القيود كما استخرجتُها من قاعدة البيانات الفعلية بعد الهجرة:

```
CHECK CHK_reservation_items_quantity_positive => CHECK ((quantity > 0))
CHECK CHK_reservations_status                 => CHECK ((status = ANY (ARRAY['RESERVED'::text, 'RELEASED'::text])))
CHECK CHK_stock_available_non_negative        => CHECK ((available >= 0))
CHECK CHK_stock_reserved_non_negative         => CHECK ((reserved >= 0))
```

**لماذا `status` نصّ مع CHECK بدل enum في PostgreSQL؟** إضافة حالة جديدة لاحقاً تصبح
تعديل قيد بسيطاً لا ترحيل نوع.

---

## ٣. الشروح المطلوبة

### أ. لماذا يمنع الـ UPDATE الشرطي البيعَ الزائد بلا `SELECT ... FOR UPDATE`

العبارة الوحيدة التي تلمس المخزون هي:

```sql
UPDATE stock
   SET available = available - $2,
       reserved  = reserved  + $2,
       updated_at = now()
 WHERE product_id = $1
   AND available >= $2
RETURNING product_id, available, reserved
```

الفكرة أن **الفحص والخصم عبارة واحدة غير قابلة للتجزئة**. ولفهم ذلك تخيّل البديل الساذج:

```
tx A:  SELECT available FROM stock WHERE product_id='1'   -- يقرأ 1
tx B:  SELECT available FROM stock WHERE product_id='1'   -- يقرأ 1 أيضاً
tx A:  UPDATE ... SET available = 0                        -- ينجح
tx B:  UPDATE ... SET available = 0                        -- ينجح أيضاً!
```

كلاهما باع الوحدة الأخيرة. المشكلة أن فجوة زمنية تفصل القراءة عن الكتابة، وأي معاملة
أخرى تستطيع الالتزام داخل تلك الفجوة.

أما في العبارة الشرطية فما يحدث فعلياً:

1. معاملة A تنفّذ الـ UPDATE فتأخذ **قفل صف** على `product_id='1'`.
2. معاملة B تنفّذ العبارة نفسها فتجد الصف مقفلاً، **فتنتظر**.
3. تلتزم A (`available` صار 0) فيُحرَّر القفل.
4. هنا السلوك الحاسم: تحت مستوى العزل الافتراضي **READ COMMITTED**، لا تكمل B بالقيمة
   القديمة التي كانت ستراها — بل **تعيد تقييم شرط `WHERE` على القيمة الملتزَمة الجديدة**
   (آلية EvalPlanQual). والشرط `available >= 1` صار `0 >= 1` أي خطأ.
5. فلا تطابق B أي صف، و`RETURNING` تعيد صفراً من الصفوف، فنعرف أنها رُفضت.

ولذلك لا نحتاج `SELECT ... FOR UPDATE`: الـ UPDATE يقفل بنفسه، والشرط يُعاد تقييمه بعد
القفل. هذا ما يجعل **واحداً بالضبط** ينجح مهما بلغ عدد المتسابقين.

### ب. لماذا يمنع الترتيب الـ deadlock

```ts
function byProductId<T extends { productId: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
  );
}
```

من دون ترتيب، طلبان متزامنان على المنتجين نفسيهما بترتيب معكوس:

```
tx A: يقفل '5' ثم ينتظر '9'
tx B: يقفل '9' ثم ينتظر '5'
```

كلٌّ يحمل ما يحتاجه الآخر — جمود تام، وPostgreSQL يقتل إحدى المعاملتين بعد مهلة كشف
الـ deadlock. مع الترتيب التصاعدي، كل معاملة تمشي على الصفوف **بالتسلسل نفسه**، فأسوأ ما
يحدث أن تنتظر الثانية الأولى ثم تكمل.

**ملاحظة مهمّة في التنفيذ:** استعملتُ مقارنة بايتية (`<` و`>`) لا `localeCompare`. فالأخيرة
تعتمد على الإعدادات المحلّية، وقد ترتّب عمليتان على خادمين مختلفين بترتيبين مختلفين —
فيعود الـ deadlock من حيث أُغلق الباب.

### ج. ما الذي تحرسه قيود CHECK

القيود ليست تكراراً لتحقّق التطبيق، بل **خطّ الدفاع الأخير**:

- `available >= 0` — لا يمكن لأي تسلسل أحداث، ولا لخلل برمجي مستقبلي، ولا لتعديل يدوي
  بـ `UPDATE`، أن يترك المستودع وقد وعد بوحدات لا يملكها. لو وقع خطأ في المنطق تفشل
  المعاملة بصوت عالٍ بدل أن تفسد البيانات بصمت.
- `reserved >= 0` — يكشف التحرير المزدوج: محاولة إعادة وحدات لم تُحجز تُرفض.
- `status IN ('RESERVED','RELEASED')` — يمنع ظهور حالة ثالثة مجهولة يتعامل معها المنطق
  بشكل غير معرَّف.
- `quantity > 0` في `reservation_items` — يمنع تسجيل سطر حجز بكمية صفرية أو سالبة.

### د. سيناريو شاهدة القبر (tombstone)

هذا السيناريو هو سبب وجود الـ tombstone، وهو تحديداً ما يحدث عند انتهاء مهلة العميل:

```
1. التطبيق الأساسي: ReserveStock(reservation_id = R)    ← الطلب يغادر
2. الشبكة تتباطأ. ينقضي deadline العميل.
   العميل يتلقّى DEADLINE_EXCEEDED ولا يعرف: هل وصل الحجز أم لا؟
3. التطبيق يعوّض: ReleaseStock(R)
   خدمة المخزون لا تجد R  →  تكتب صفاً RELEASED بلا أسطر (tombstone)
                           →  تُجيب released = false
4. الآن يصل طلب الخطوة (1) أخيراً إلى الخادم.
5. المعالج يجد R موجوداً بحالة RELEASED
   →  FAILED_PRECONDITION
```

**من دون شاهدة القبر** كانت الخطوة ٥ ستجد `R` غير موجود، فتحجز المخزون من جديد — لطلبٍ
تخلّى عنه صاحبه. وحدات محجوزة إلى الأبد لا ينتظرها أحد، ومخزون يتسرّب مع كل انقطاع شبكة.

وهذا بالضبط ما تحقّقتُ منه حيّاً:

```
PASS  releasing an unknown id reports released=false -> {"released":false}
PASS  a late reserve on that id is refused by the tombstone
      -> code=9 (FAILED_PRECONDITION)
```

---

## ٤. اكتشاف حرج: شكل ناتج `query()` في TypeORM 1.1.2

هذا كان سيسبّب **بيعاً زائداً صامتاً**، ولم يكشفه إلا الاختبار الفعلي.

في TypeORM 0.3.x يعيد `query()` مصفوفة الصفوف مباشرةً، فيكون الفحص الطبيعي
`result.length === 1`. لكنّي اختبرتُ السلوك الحقيقي في 1.1.2:

```
SUCCESS update  -> [[{"product_id":"probe","available":1}], 1]
BLOCKED update  -> [[], 0]
UNKNOWN product -> [[], 0]
```

أي أن الناتج **ثنائية `[rows, affectedCount]` لا مصفوفة صفوف**. ومعنى ذلك أن
`result.length` تساوي **٢ دائماً** — للعبارة الناجحة والمرفوضة على حدّ سواء. فلو بنيتُ
المنطق على الافتراض القديم لكان كل حجزٍ مرفوض يُقرأ على أنه ناجح، ولباع المستودع ما لا
يملك من دون أي رسالة خطأ.

الحل في `returnedRows()` يتعامل مع الشكلين معاً، حتى لا تعود المشكلة بصمت عند ترقية
المكتبة:

```ts
export function returnedRows<T>(result: unknown): T[] {
  if (
    Array.isArray(result) && result.length === 2 &&
    Array.isArray(result[0]) && typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
}
```

تحقّقتُ أيضاً في التجربة نفسها من أن قيد CHECK يُفرَض فعلاً:

```
UPDATE stock SET available = -1 ...
-> new row for relation "stock" violates check constraint "CHK_stock_available_non_negative"
```

---

## ٥. قرارات تصميم أخرى

**`ShortagesDetected` إشارة تراجع داخلية.** نقص المخزون استجابة ناجحة بـ
`reserved = false`، لكن الخصومات الجزئية التي تمّت قبل اكتشاف النقص يجب التراجع عنها.
والرمي هو الوسيلة الوحيدة لإجهاض معاملة، فيُرمى هذا الخطأ داخلها ويُحوَّل إلى استجابة
عادية خارجها. وهو عمداً **ليس** `DomainError` كي لا يصل إلى مرشّح الاستثناءات أبداً.

**جمع كل النواقص لا أوّلها.** الحلقة تكمل على كل الأصناف وتجمع كل نقص، فيعرف العميل كل
المشاكل دفعة واحدة بدل اكتشاف واحدة في كل إعادة محاولة.

**التمييز بين المنتج المجهول والنقص.** حين لا يطابق الـ UPDATE شيئاً، يُقرأ الصف: إن لم
يوجد فهو `NOT_FOUND` (خطأ العميل)، وإن وُجد فهو نقص (نتيجة تجارية). الفرق جوهري للمستدعي.

**التعامل مع تسابق على نفس `reservation_id`.** معاملتان بالمعرّف نفسه لا ترى إحداهما صفّ
الأخرى غير الملتزَم، فتخصمان معاً وتحاولان الإدراج؛ إحداهما تفشل بانتهاك التفرّد
فيُتراجَع عن خصمها بالكامل، ثم نُعيد قراءة النتيجة الملتزَمة ونُرجعها. فالخصم يحدث مرّة
واحدة بالضبط.

**التأخير الاصطناعي قبل فتح المعاملة** لا داخلها — الهدف إظهار انتهاء مهلة العميل، لا
تعطيل المستودع بقفل صف طوال مدة التأخير.

---

## ٦. الـ seed

معرّفات ثابتة مكتوبة يدوياً، و**لا قراءة إطلاقاً من قاعدة التطبيق الأساسي** (ذلك كان
سيهدم حدود قاعدة-لكل-خدمة). تحقّقتُ أن التطبيق الأساسي **لا يملك seed**، فاستعملتُ
`"1".."8"` وهي المعرّفات التي يمنحها PostgreSQL لأول ثمانية منتجات تُنشأ عبر
`POST /products`.

| product_id | available | الغرض |
| --- | --- | --- |
| **1** | **1** | الوحدة الأخيرة — موضوع عرض التسابق |
| 2 | 5 | مخزون صغير |
| 3 | 10 | — |
| 4 | 25 | — |
| 5 | 50 | — |
| 6 | 100 | — |
| **7** | **0** | نفد — لسيناريوهات النقص |
| 8 | 7 | — |

---

## ٧. نتائج بوّابة المرحلة ٣ (مخرجات فعلية)

### الهجرة تعمل وتتراجع

```
migration:run     Migration CreateInventorySchema1762500000000 has been executed successfully.
migration:revert  Migration CreateInventorySchema1762500000000 has been reverted successfully.
tables after revert: migrations          ← لم يبقَ أي جدول من المخطّط
migration:run     executed successfully   ← وأعيد التشغيل بنجاح
tables: migrations, reservation_items, reservations, stock
```

### الـ seed يعمل مرّتين بلا تكرار

```
تشغيل ١: 8 stock rows present.
تشغيل ٢: 8 stock rows present.
فحص مباشر: rows: 8 | total available: 198
```

### النداءات اليدوية للعمليات الثلاث — ٢١ فحصاً

```
PASS  GetStock returns seeded rows and omits unknown ids
PASS  GetStock with an empty list returns an empty list
PASS  ReserveStock succeeds when stock is sufficient   -> {"shortages":[],"reserved":true}
PASS  the same reservation id is idempotent
PASS  stock moved from available to reserved exactly once -> available 48, reserved 2
PASS  ReleaseStock gives the units back                -> {"released":true}
PASS  stock is restored after the release              -> available 50, reserved 0
PASS  releasing twice is idempotent
PASS  reserving a released id is refused               -> code=9 (FAILED_PRECONDITION)
PASS  a shortage is a response, not an error
      -> {"shortages":[{"productId":"7","requested":1,"available":0}],"reserved":false}
PASS  all-or-nothing: one short item blocks the whole order
PASS  the sufficient item was rolled back              -> available 100, reserved 0
PASS  releasing an unknown id reports released=false
PASS  a late reserve on that id is refused by the tombstone -> code=9
PASS  an unknown product is NOT_FOUND                  -> code=5 "Unknown product "nope""
PASS  the same product twice is INVALID_ARGUMENT       -> code=3
PASS  empty items is rejected by validation            -> code=3
PASS  missing reservationId is rejected by validation  -> code=3
PASS  zero quantity is rejected by validation          -> code=3
(+ فحصا reflection و health)

================  ALL CHECKS PASSED  ================
```

### حالة قاعدة البيانات بعد الفحص

```
stock:  1→1  2→5  3→10  4→25  5→50  6→100  7→0  8→7     (مطابق للـ seed تماماً)
reservations by status: [{"status":"RELEASED","n":2}]
```

أي أن سلسلة الفحوص لم تترك أي أثر على المخزون — دليل عملي إضافي على أن التراجع والتحرير
يعملان.

### البناء والتدقيق

```
npm run build   exit=0
npm run lint    exit=0
npx tsc --noEmit -p tsconfig.scripts.json   exit=0
```

**بوّابة المرحلة ٣ مجتازة بالكامل.**

---

## ٨. انحرافات وملاحظات

**انحراف:** التكليف وصف `reservations` بعمود `status` فقط. أضفتُ `CHK_reservations_status`
و`CHK_reservation_items_quantity_positive` كما ورد في وصفك، ولم أضف أي عمود غير مذكور.

**عقبة تقنية حُلَّت:** TypeORM 1.x يرفض ملف DataSource يُصدِّر أكثر من نسخة واحدة
(`Given data source file must contain only one export of DataSource instance`). حذفتُ
التصدير المُسمّى وأبقيتُ الافتراضي فقط.

**اعتماد جديد:** `dotenv@17.2.3` — تحتاجه واجهة TypeORM السطرية والـ seed لأنهما يعملان
خارج Nest، فلا يحمّل `ConfigModule` ملف `.env` نيابةً عنهما.

---

## ٩. مخاطر مفتوحة

- **التسابق لم يُثبَت بعد تحت حمل حقيقي.** كل ما سبق نداءات متتابعة. إثبات «واحد بالضبط
  من ٥٠» هو بوّابة المرحلة ٥.
- **`DB_STATEMENT_TIMEOUT_MS` ما زال غير مُختبَر** — لا يوجد استعلام طويل بما يكفي.
- **`INVENTORY_ARTIFICIAL_DELAY_MS` منفّذ لكن غير مُختبَر**؛ اختباره مع deadline أقصر في
  المرحلة ٥.

---

## الخطوة التالية

**المرحلة ٤** — Dockerfile متعدّد المراحل بسياق بناء من جذر المستودع، و
`docker-compose.yml` مستقلّ، وبقية سكربتات npm، و`README.md` مع قسم ملاحظات التكامل.
