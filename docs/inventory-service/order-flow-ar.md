# خريطة سير الطلب — من الحجز إلى تأكيد الطلب

**الغرض:** تتبّع رحلة طلب واحد عبر التطبيقين سطراً بسطر، لتمشي على أهم أجزاء الكود أثناء المناقشة.
**التاريخ:** ٨ تشرين الثاني / نوفمبر ٢٠٢٦

---

## ١. الخريطة الكاملة

```
                 التطبيق الأساسي (NestJS، منفذ 3000)          خدمة المستودع (NestJS، منفذ 50051)
                 ══════════════════════════════════          ═══════════════════════════════════
  العميل
    │
    │ POST /orders
    │ { items: [{ productId: 1, quantity: 2 }] }
    ▼
 ┌─────────────────────────────────┐
 │ JwtAuthGuard → RolesGuard       │  ① من أنت؟
 │ ValidationPipe                  │  ② هل الطلب صالح شكلاً؟
 └──────────────┬──────────────────┘
                ▼
 ┌─────────────────────────────────┐
 │ OrdersController.create()       │
 └──────────────┬──────────────────┘
                ▼
 ┌─────────────────────────────────┐
 │ OrdersService.create()          │
 │                                 │
 │ ③ رفض المنتج المكرّر  ← 400     │  (تحقّق محلّي رخيص أولاً)
 │ ④ reservationId = randomUUID()  │
 └──────────────┬──────────────────┘
                ▼
 ┌─────────────────────────────────┐
 │ OrdersService.reserve()         │
 └──────────────┬──────────────────┘
                ▼
 ┌─────────────────────────────────┐          gRPC / HTTP2 / Protobuf
 │ InventoryClient.reserveStock()  │ ═══════════════════════════════════►┌──────────────────────────────┐
 │  deadline = 3000ms              │   ReserveStock(reservationId,       │ InventoryController          │
 │  productId → String(id)         │                items[])             │  @GrpcMethod (مولَّد)         │
 └─────────────────────────────────┘                                     └───────────────┬──────────────┘
                                                                                         ▼
                                                                         ┌──────────────────────────────┐
                                                                         │ ValidationPipe → DTO         │
                                                                         │ InventoryService.reserveStock│
                                                                         │                              │
                                                                         │ ⑤ رفض المكرّر                 │
                                                                         │ ⑥ معاملة واحدة:              │
                                                                         │    • هل المعرّف موجود؟       │
                                                                         │      RESERVED → نجاح فوري    │
                                                                         │      RELEASED → 9 FAILED_PRE │
                                                                         │    • ترتيب الأصناف بالمعرّف  │
                                                                         │    • UPDATE شرطي لكل صنف     │
                                                                         │    • جمع كل النواقص          │
                                                                         │    • إدراج الحجز + أسطره     │
                                                                         └───────────────┬──────────────┘
                                                                                         │
 ┌─────────────────────────────────┐◄════════════════════════════════════════════════════┘
 │ الجواب                          │   { reserved: true,  shortages: [] }
 │                                 │   { reserved: false, shortages: [...] }
 │  reserved=false → 409 + النواقص │   أو خطأ gRPC: 5 / 3 / 9 / 14 / 4
 │  خطأ gRPC       → تعويض ثم 503  │
 └──────────────┬──────────────────┘
                │ reserved = true
                ▼
 ┌─────────────────────────────────┐
 │ OrdersService.writeOrder()      │  ⑦ معاملة قاعدة البيانات
 │  ├─ قراءة الأسعار من الكتالوج   │     (إعادة المحاولة هنا فقط،
 │  ├─ بناء الأسطر + الإجمالي      │      والحجز خارجها)
 │  └─ INSERT order + order_items  │
 └──────────────┬──────────────────┘
                │
        ┌───────┴────────┐
     نجح │                │ فشل
        ▼                ▼
 ┌────────────┐   ┌──────────────────────────────┐
 │ 201 Created│   │ OrdersService.compensate()   │
 │ status:    │   │  ReleaseStock(reservationId) │ ═══════════════════════════════►  إرجاع الكميات
 │ PENDING    │   │  ثم رمي الخطأ الأصلي          │                                   أو شاهدة قبر
 └────────────┘   └──────────────────────────────┘
```

---

## ٢. التتبّع بالكود — الملفات والأسطر

| # | ماذا يحدث | الملف | السطر |
| --- | --- | --- | --- |
| ① | المصادقة والصلاحيات | `src/auth/guards/jwt-auth.guard.ts` | — |
| ② | التحقّق من الشكل | `src/orders/dto/create-order.dto.ts` | — |
| | نقطة الدخول | [`src/orders/orders.controller.ts`](../../src/orders/orders.controller.ts) | **33، 39** |
| ③④ | رفض المكرّر + توليد المعرّف | [`src/orders/orders.service.ts`](../../src/orders/orders.service.ts) | **69** |
| | الحجز | `src/orders/orders.service.ts` | **98** |
| | نداء gRPC | [`src/inventory/inventory.client.ts`](../../src/inventory/inventory.client.ts) | **123** ثم **143** |
| | ترجمة الأخطاء | [`src/inventory/inventory.errors.ts`](../../src/inventory/inventory.errors.ts) | **36، 61** |
| ⑤ | استقبال النداء | `inventory-service/src/inventory/inventory.controller.ts` | **32، 40** |
| ⑥ | منطق الحجز | `inventory-service/src/inventory/inventory.service.ts` | **125، 153** |
| | الـ UPDATE الشرطي | `inventory-service/src/inventory/inventory.service.ts` | **47** |
| ⑦ | كتابة الطلب | `src/orders/orders.service.ts` | **138، 189** |
| | التعويض | `src/orders/orders.service.ts` | **164** |

---

## ٣. المحطّات الست التي تستحقّ الشرح

### المحطّة ١ — لماذا يُولَّد `reservationId` عندنا لا عندهم؟

`src/orders/orders.service.ts:69`

```ts
const reservationId = randomUUID();
await this.reserve(reservationId, dto);
```

لو كان المستودع هو من يولّده، لما استطعنا تسمية الحجز عند انقطاع الاتصال. تخيّل: أرسلنا
الحجز، انقطعت الشبكة قبل وصول الجواب. من دون معرّف نعرفه مسبقاً، لا نملك أي وسيلة لنسأل
«ماذا حدث لحجزي؟» ولا لإلغائه. بتوليده عندنا، **نملك اسم العملية قبل أن تبدأ**.

### المحطّة ٢ — لماذا الحجز **خارج** المعاملة؟

`src/orders/orders.service.ts:69`

```ts
await this.reserve(reservationId, dto);      // ← خارج
try {
  return await this.writeOrder(dto, currentUser);   // ← المعاملة بالداخل
} catch (error) {
  await this.compensate(reservationId, error);
  throw error;
}
```

لو وضعنا نداء الشبكة **داخل** `dataSource.transaction`، لبقيت أقفال صفوف قاعدة بياناتنا
محجوزة طوال زمن الذهاب والإياب إلى خدمة أخرى — وربطنا نجاح التزامنا بزمن استجابة شبكة.
معاملة قاعدة البيانات يجب أن تكون أقصر ما يمكن.

### المحطّة ٣ — نداء **واحد** لكل السلّة

`src/inventory/inventory.client.ts:123`

```ts
reserveStock(reservationId: string, items: ReserveItemInput[]) {
  return this.call('ReserveStock', { reservationId, items }, reserveTimeoutMs());
}
```

الكرّاسة تنصّ على «طلب واحد للتحقّق والحجز لكل أصناف الطلب». ولهذا `ReserveItem` في العقد
**مصفوفة**. ولو ناديناه لكل صنف على حدة لفقدنا خاصية **الكل-أو-لا-شيء**: قد ينجح الصنف
الأول ويفشل الثاني فنبقى بحجز معلّق.

### المحطّة ٤ — القلب: الـ UPDATE الشرطي

`inventory-service/src/inventory/inventory.service.ts:47`

```sql
UPDATE stock
   SET available = available - $2,
       reserved  = reserved  + $2
 WHERE product_id = $1
   AND available >= $2        -- ← هنا تُمنع المبالغة في البيع
RETURNING product_id, available, reserved
```

الفحص والخصم **عبارة واحدة غير قابلة للتجزئة**. البديل الساذج (اقرأ ثم اكتب) يترك فجوة
زمنية تستطيع معاملة أخرى أن تلتزم داخلها، فيبيع الاثنان الوحدة الأخيرة.

ما يحدث فعلياً عند التزاحم:

1. المعاملة A تنفّذ الـ UPDATE فتأخذ **قفل صف**.
2. المعاملة B تصل للعبارة نفسها فتجد الصف مقفلاً، **فتنتظر**.
3. تلتزم A (`available` صار 0) فيُحرَّر القفل.
4. تحت عزل **READ COMMITTED**، لا تكمل B بالقيمة القديمة — بل **تعيد تقييم شرط `WHERE`
   على القيمة الجديدة**. الشرط `0 >= 1` خطأ.
5. فلا تطابق B أي صف، و`RETURNING` تعيد صفراً من الصفوف.

ولهذا لا نحتاج `SELECT ... FOR UPDATE` إطلاقاً.

### المحطّة ٥ — «لا» تجارية مقابل «لا» تقنية

`src/inventory/inventory.errors.ts:36` و`:61`

| جواب المستودع | HTTP | المعنى |
| --- | --- | --- |
| `reserved=false` + نواقص | **409** | النداء نجح، والبضاعة ناقصة |
| `NOT_FOUND` (5) | 404 | منتج لا يعرفه المستودع |
| `INVALID_ARGUMENT` (3) | 400 | خطأ في طلبنا نحن |
| `FAILED_PRECONDITION` (9) | 409 | حجز سبق تحريره |
| `UNAVAILABLE` (14) · `DEADLINE_EXCEEDED` (4) | **503** | المستودع متوقّف أو بطيء |

هذا الفصل هو النقطة المعمارية الأهم في العقد: **نفاد المخزون ليس خطأً**، بل جواب صحيح عن
سؤال صحيح. أما الأخطاء التقنية فرموز gRPC.

### المحطّة ٦ — التعويض لا يرمي أبداً

`src/orders/orders.service.ts:164`

```ts
private async compensate(reservationId: string, cause: unknown) {
  try {
    const { released } = await this.inventory.releaseStock(reservationId);
    this.logger.warn(`Released reservation ${reservationId} ... (released=${released})`);
  } catch (releaseError) {
    this.logger.error(`COMPENSATION FAILED for ${reservationId}; stock may stay reserved`, ...);
  }
}
```

العميل يتلقّى أصلاً خطأً عن المشكلة الأصلية؛ ولو رمى التعويض خطأً ثانياً لأخفى السبب.
أما فشل التحرير فيُسجَّل بصوت عالٍ لأنه يعني مخزوناً محجوزاً لطلب غير موجود.

**ودقّة إضافية:** التعويض يُنادى أيضاً حين **يفشل الحجز نفسه** بانتهاء مهلة
(`orders.service.ts:98`). السبب أن مهلة gRPC توقف انتظار **العميل** لا عمل **الخادم** —
وقد أثبتنا ذلك حيّاً في المرحلة ٦.

---

## ٤. المسارات الأربعة الممكنة

| # | ماذا يحدث | ما يراه العميل | المخزون بعدها |
| --- | --- | --- | --- |
| ١ | كل شيء ينجح | `201` والطلب `PENDING` | `available−q`, `reserved+q` |
| ٢ | المخزون غير كافٍ | `409` + قائمة النواقص | **بلا تغيير** (تراجعت المعاملة) |
| ٣ | المستودع متوقّف/بطيء | `503` «لم يُنشَأ طلبك» | بلا تغيير (+ شاهدة قبر تحسّباً) |
| ٤ | الحجز نجح ثم فشل الحفظ | `500` | **يعود كما كان** عبر التعويض |

---

## ٥. مسار عرض المنتج (أبسط بكثير)

```
GET /products/:id
   → ProductsController.findOne()
   → ProductsService.findOneWithStock()        src/products/products.service.ts:111
   → ProductsService.stockFor([product])       src/products/products.service.ts:49
   → InventoryClient.getStock(['1'])           deadline 1500ms
   → GetStock عبر gRPC
   → { stock: { available, reserved } }
```

وفارقان مهمّان عن مسار الطلب:

1. **نداء دفعي واحد لكل صفحة** لا نداء لكل منتج — ولهذا `GetStock` يأخذ قائمة.
2. **لا يرمي عند تعذّر الوصول**: يعيد `stock: null` والكتالوج يبقى يعمل. صفحة منتج بلا رقم
   مخزون أفضل بكثير من صفحة خطأ. أما الطلب فلا يعتمد على هذه القراءة إطلاقاً — يحجز، وهي
   عملية ذرّية.

---

## ٦. ملفات تستحقّ الفتح أثناء المناقشة

بالترتيب:

1. [`proto/inventory/v1/inventory.proto`](../../proto/inventory/v1/inventory.proto) — العقد
2. [`src/orders/orders.service.ts`](../../src/orders/orders.service.ts) — الأسطر 69–187
3. [`src/inventory/inventory.client.ts`](../../src/inventory/inventory.client.ts) — الأسطر 123–165
4. [`src/inventory/inventory.errors.ts`](../../src/inventory/inventory.errors.ts) — جدول الترجمة
5. `inventory-service/src/inventory/inventory.service.ts` — الأسطر 47–75 و153–215

**اقرأ أيضاً:** [شرح gRPC](grpc-explained-ar.md) · [خطوات التجريب اليدوي](manual-testing-ar.md)
