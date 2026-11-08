# المرحلة ٦ — ربط الخدمتين عبر gRPC وإثبات المتطلّب الثاني كاملاً

**نطاق هذه المرحلة:** ربط التطبيق الأساسي بخدمة المخزون، واختبار المتطلّب الثاني من طرف إلى طرف
**التاريخ:** ٨ تشرين الثاني / نوفمبر ٢٠٢٦
**السابق:** [٠](inventory-service-phase-0-ar.md) · [١](inventory-service-phase-1-ar.md) · [٢](inventory-service-phase-2-ar.md) · [٣](inventory-service-phase-3-ar.md) · [٤](inventory-service-phase-4-ar.md) · [٥](inventory-service-phase-5-ar.md)

---

## ١. تغيّر في الصلاحيات

كانت القاعدة في المراحل ٠–٥: **ممنوع تعديل `src/` في التطبيق الأساسي**. وطلبُك ربطَ
الخدمتين يُلغي هذا المنع بالضرورة — فالربط يحدث داخل وحدة الطلبات ووحدة المنتجات. وهذه
قائمة كل ملف لمستُه في التطبيق الأساسي:

| الملف | التعديل |
| --- | --- |
| `src/inventory/**` | **جديد كلياً** — عميل gRPC، الإعدادات، ترجمة الأخطاء، الأنواع المولَّدة |
| `src/app.module.ts` | تسجيل `InventoryModule` |
| `src/orders/orders.service.ts` | الحجز قبل المعاملة + التعويض |
| `src/products/products.service.ts` | قراءة الكميات دفعةً واحدة |
| `src/products/products.controller.ts` | `GET /products/:id` صار يمرّ عبر `findOneWithStock` |
| `src/products/dto/product-response.dto.ts` | إضافة حقل `stock` |
| `src/common/filters/http-exception.filter.ts` | الحفاظ على الحقول الإضافية (مثل `shortages`) |
| `Dockerfile` · `docker-compose.yml` · `.env.example` · `package.json` · `tsconfig.json` | ربط ونشر |
| `test/orders.e2e-spec.ts` · `test/products.e2e-spec.ts` | محاكاة العميل + اختبارات جديدة |
| `scripts/requirement2-demo.ts` · `tsconfig.scripts.json` · `buf.gen.yaml` | عرض وإثبات |

---

## ٢. مطابقة بنود المتطلّب الثاني

| البند في الكرّاسة | الحالة | أين |
| --- | --- | --- |
| خدمة المستودع: خادم gRPC مستقل بقاعدة بيانات خاصّة | ✅ | المراحل ٢–٤ |
| العقد: ملف proto بثلاث عمليات | ✅ | `proto/inventory/v1/inventory.proto` |
| **عرض تفاصيل المنتج مع الكمية المتوفّرة** | ✅ | `GET /products/:id` و`GET /products` يحملان `stock` |
| **إنشاء الطلب: طلب واحد للتحقّق والحجز لكل الأصناف** | ✅ | نداء `ReserveStock` واحد قبل المعاملة |
| إذا رُدّت بالموافقة يُنشَأ الطلب، وإن رُفضت لا يُنشَأ | ✅ | مُبرهَن حيّاً |
| **فشل: الكمية غير كافية ← رسالة واضحة** | ✅ | `409` مع قائمة النواقص |
| **فشل: الخدمة متوقّفة أو لا تردّ خلال مهلة** | ✅ | `503` برسالة صريحة، بلا انتظار لا نهائي |
| **فشل: الحجز نجح لكن حفظ الطلب فشل ← تُرجَع الكمية** | ✅ | تعويض `ReleaseStock` |
| **إثبات: عدة طلبات متزامنة على آخر قطعة ← واحد فقط ينجح** | ✅ | ٣٠ طلباً: 1×201 و29×409 |
| **إثبات: ماذا يرى المستخدم عند إيقاف الخدمة** | ✅ | مطبوع حرفياً في العرض |

---

## ٣. أهم أجزاء الكود

### أ. عميل gRPC — `src/inventory/inventory.client.ts`

قناة واحدة لكل العملية، و**مهلة على كل نداء**، ولا يتسرّب أي مفهوم gRPC إلى الأعلى.

```ts
private call<T>(method: string, payload: unknown, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    client[method](
      payload,
      { deadline: new Date(Date.now() + timeoutMs) },   // ← بلا هذه ينتظر العميل للأبد
      (error, value) => (error ? reject(error) : resolve(value)),
    );
  });
}
```

ثلاث مهل مختلفة، لأن العمليات ليست متساوية:

| العملية | المهلة | السبب |
| --- | --- | --- |
| `GetStock` | 1500ms | قراءة لعرض صفحة؛ لا تستحقّ تعطيل المستخدم |
| `ReserveStock` | 3000ms | تكتب، فتستحقّ هامشاً أكبر |
| `ReleaseStock` | 5000ms | **تعويض**: يعمل بعد فشلٍ أصلاً، فلا يرث مهلةً منتهية |

و`getStock` تبتلع تعذّر الوصول وتعيد خريطة فارغة: صفحة منتج بلا رقم مخزون أفضل بكثير من
صفحة خطأ. أما الحجز فلا يعتمد عليها إطلاقاً — هو عملية ذرّية في الخدمة نفسها.

### ب. تدفّق إنشاء الطلب — `src/orders/orders.service.ts`

هذا جوهر المتطلّب. الترتيب مقصود بالكامل:

```ts
async create(dto, currentUser) {
  // ... رفض المنتج المكرّر (تحقّق محلّي رخيص أولاً)

  const reservationId = randomUUID();        // ① نولّده نحن، قبل النداء
  await this.reserve(reservationId, dto);    // ② الحجز خارج المعاملة

  try {
    return await this.writeOrder(dto, currentUser);   // ③ الكتابة داخل معاملة
  } catch (error) {
    await this.compensate(reservationId, error);      // ④ التعويض عند أي فشل
    throw error;
  }
}
```

**① لماذا نولّد المعرّف نحن؟** لأن إعادة المحاولة أو التعويض يجب أن يسمّيا الحجز نفسه.
بدونه، نداء انتهت مهلته لا يمكن التراجع عنه إطلاقاً.

**② لماذا الحجز خارج المعاملة؟** نداء شبكي داخل معاملة قاعدة بيانات يُبقي أقفال الصفوف
محجوزة طوال زمن الذهاب والإياب، ويربط مصير الالتزام بزمن استجابة خدمة أخرى.

**③ إعادة المحاولة تخصّ المعاملة وحدها.** حلقة `order_number` موجودة من المتطلّب الأول،
ونُقلت داخل `writeOrder` — فالحجز **خارجها**:

```ts
private async writeOrder(dto, currentUser) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await this.loadOrFail(await this.placeOrder(dto, currentUser)); }
    catch (error) {
      if (isUniqueViolation(error) && attempt < ORDER_NUMBER_ATTEMPTS) continue;
      throw error;
    }
  }
}
```

لو بقي الحجز داخل الحلقة لحُجزت السلّة مرّتين عند أول تصادم في رقم الطلب. وهناك اختبار
يحرس هذا تحديداً.

**④ التعويض لا يرمي أبداً:**

```ts
private async compensate(reservationId, cause) {
  try {
    const { released } = await this.inventory.releaseStock(reservationId);
    this.logger.warn(`Released reservation ${reservationId} ... (released=${released})`);
  } catch (releaseError) {
    this.logger.error(`COMPENSATION FAILED for ${reservationId}; stock may stay reserved`, ...);
  }
}
```

العميل يتلقّى أصلاً خطأً عن المشكلة الأصلية؛ واستبداله بخطأ ثانٍ يُخفي السبب. أما فشل
التحرير فيُسجَّل بصوت عالٍ لأنه يعني مخزوناً محجوزاً لطلب غير موجود.

**نقطة دقيقة:** التعويض يُنادى أيضاً حين **يفشل الحجز نفسه** بانتهاء مهلة — لأن مهلة
gRPC تُوقف انتظار العميل لا عمل الخادم (أثبتناه في المرحلة ٥). وقد برهنّا حيّاً في هذه
المرحلة أن هذا يعمل.

### ج. ترجمة الأخطاء — `src/inventory/inventory.errors.ts`

يفصل بين نوعَي «لا»:

| الجواب | HTTP | لماذا |
| --- | --- | --- |
| `reserved = false` + نواقص | **409** | نتيجة تجارية: النداء نجح والبضاعة ناقصة |
| `NOT_FOUND` | 404 | منتج لا يعرفه المستودع |
| `INVALID_ARGUMENT` | 400 | خطأ في طلبنا نحن |
| `FAILED_PRECONDITION` | 409 | حجز سبق تحريره |
| `UNAVAILABLE` / `DEADLINE_EXCEEDED` | **503** | «الخدمة غير متاحة/لم تردّ — لم يُنشَأ طلبك» |
| غير ذلك | 500 | بلا تسريب أي تفصيل داخلي |

### د. الحفاظ على النواقص في الصيغة الموحّدة

`AllExceptionsFilter` من المتطلّب الأول كان **يبتلع** حقل `shortages`. كشفه اختبار
فأصلحتُ المرشّح ليمرّر الحقول الإضافية مع إبقاء الحقول الخمسة القياسية لها الأولوية:

```ts
const { error, message, extra } = this.describe(exception, status);
response.status(status).json({
  statusCode: status, error, message,
  ...extra,                        // ← shortages وغيرها
  path: request.url, timestamp: new Date().toISOString(),
});
```

تغيير **إضافي ومتوافق رجعياً**: الحقول الإضافية تظهر فقط حين يرفقها الاستثناء.

### هـ. عرض الكمية — `src/products/products.service.ts`

نداء دفعي **واحد لكل صفحة**، لا نداء لكل منتج — ولهذا صُمّم `GetStock` ليأخذ قائمة:

```ts
const stock = await this.stockFor(products);     // نداء gRPC واحد
return PaginatedResponseDto.of(
  products.map((p) => ProductResponseDto.fromEntity(p, stock.get(p.id) ?? null)),
  ...
);
```

و`stock: null` حين يتعذّر الوصول — صريحة كي يقول العميل «غير متاح» بدل «صفر».

---

## ٤. الإثبات الحيّ (مخرجات فعلية)

البيئة: خدمة المخزون وقاعدتها في Docker (`50051` و`5434`)، والتطبيق الأساسي محلّياً على
`3000` مع قاعدته في Docker على `5433`.

### العرض الكامل — `npm run demo:req2 -- 30`

```
1. PRODUCT DETAILS CARRY THE WAREHOUSE QUANTITY
  PASS  GET /products/:id returns 200
  PASS  the response includes a stock block -> {"available":500,"reserved":0}
  PASS  the product list carries stock too (one batch gRPC call per page)

2. A NORMAL ORDER RESERVES STOCK
  PASS  order accepted (201)
  PASS  available dropped by 2 and reserved rose by 2
        -> before {"available":500,"reserved":0} after {"available":498,"reserved":2}

3. NOT ENOUGH STOCK -> 409 WITH THE SHORTAGES
  warehouse holds 498, the basket asks for 499
  PASS  order refused with 409
  PASS  the body names the short product
        -> [{"productId":2,"requested":499,"available":498}]
  PASS  no order was created for the refused basket -> 1 -> 1

4. THE RACE: 30 SIMULTANEOUS ORDERS FOR THE LAST UNIT
  stock before : {"available":1,"reserved":0}
  201 Created  : 1
  409 Conflict : 29
  anything else: 0
  elapsed      : 235 ms
  PASS  exactly one buyer got the last unit
  PASS  the ledger balances: available 0, reserved 1

5. THE INVENTORY SERVICE IS STOPPED
  what the customer sees:
    HTTP 503
    {
      "statusCode": 503,
      "error": "Service Unavailable",
      "message": "The inventory service is unavailable. Your order was not placed; please try again shortly.",
      "path": "/orders",
      "timestamp": "2026-11-08T13:34:35.068Z"
    }
  PASS  the customer gets 503, not a hang and not a stack trace
  PASS  the catalogue still works, with stock reported as null
  PASS  orders work again once the warehouse is back

================  ALL REQUIREMENT 2 CHECKS PASSED  ================
```

### حالة «لا تردّ خلال مهلة» — مُبرهَنة منفصلةً

أعدتُ تشغيل الحاوية بتأخير اصطناعي ٦ ثوانٍ، بينما ميزانية العميل ٣ ثوانٍ:

```
stock before : available 50, reserved 0

POST /orders  {"items":[{"productId":2,"quantity":3}]}
HTTP 503
{"message":"The inventory service did not respond in time. Your order was not placed; ..."}
elapsed: 3150 ms          ← لم ينتظر الستّ ثوانٍ

stock after  : available 50, reserved 0      ← لا تسرّب
سجلّ التطبيق: Released reservation 031aa3ba-... after a failure (released=false)
```

وهذا **أهم سطر في الإثبات كلّه**: `released=false` يعني أن التحرير وصل **قبل** أن ينتهي
الحجز على الخادم، فكتب شاهدة قبر. ثم وصل الحجز المتأخّر عند الثانية السادسة فوجدها
و**رُفض**. لولا شاهدة القبر لحُجزت ٣ وحدات لطلبٍ تخلّى عنه صاحبه، وتسرّب المخزون مع كل
انقطاع.

---

## ٥. الاختبارات الآلية

| المجموعة | قبل | بعد |
| --- | --- | --- |
| التطبيق الأساسي e2e | 74 ناجحاً | **86 ناجحاً** (+12) |
| خدمة المخزون | 30 ناجحاً | 30 ناجحاً |

الاثنا عشر اختباراً الجديدة تغطّي: نداء حجز واحد لكل سلّة بمعرّف UUID ومعرّفات نصّية ·
النقص ← 409 بلا تعويض وبلا كتابة · `UNAVAILABLE` و`DEADLINE_EXCEEDED` ← 503 **مع** تعويض ·
فشل حفظ الطلب ← تعويض بنفس المعرّف · فشل التعويض نفسه ← يبقى الخطأ الأصلي · إعادة المحاولة
تحجز **مرّة واحدة** · لا حجز حين يفشل التحقّق المحلّي · ظهور `stock` في المنتج وفي الصفحة
بنداء دفعي واحد · و`stock: null` عند تعذّر الوصول.

```
التطبيق الأساسي: build=0 · lint=0 · unit 1/1 · e2e 86 passed, 3 failed
خدمة المخزون:    build=0 · lint=0 · 30 passed
```

الإخفاقات الثلاثة هي نفسها السابقة في `test/app.e2e-spec.ts` من المتطلّب الأول، بلا زيادة.

---

## ٦. كيف تجرّب بنفسك

### التشغيل

```bash
# 1) خدمة المخزون وقاعدتها
cd inventory-service && docker compose up -d

# 2) قاعدة التطبيق الأساسي
cd .. && docker compose up -d postgres

# 3) التطبيق الأساسي (صورته لا تُبنى على هذا الجهاز — انظر المرحلة ٤)
npm run build && node dist/main
```

### العرض الجاهز للمناقشة

```bash
npm run demo:req2 -- 30      # الخمس حالات كاملة، بما فيها التسابق وإيقاف الخدمة
```

### يدوياً

```bash
# الكمية مع تفاصيل المنتج
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/products/1

# طلب
curl -X POST http://localhost:3000/orders -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"items":[{"productId":1,"quantity":1}]}'

# ضبط المخزون لعرض التسابق
cd inventory-service && docker compose exec inventory-postgres \
  psql -U postgres -d inventory -c \
  "UPDATE stock SET available=1, reserved=0 WHERE product_id='1'"

# إيقاف المستودع لرؤية 503
docker compose -f inventory-service/docker-compose.yml stop inventory
```

---

## ٧. ملاحظات ومخاطر

- **`reservation_id` لا يُخزَّن على الطلب.** المخطّط (ERD) للمتطلّب الأول لا يحوي هذا
  العمود، ولم أُضفه حفاظاً عليه. والأثر: إلغاء طلب لاحقاً لن يُحرّر مخزونه تلقائياً. إن
  أردتَ ذلك فهو عمود واحد + نداء `ReleaseStock` في مسار الإلغاء.
- **صورة التطبيق الأساسي ما زالت لا تُبنى** على هذا الجهاز لعطل شبكي (المرحلة ٤). أضفتُ
  `COPY proto ./proto` و`PROTO_DIR` إلى `Dockerfile` الجذر فالعميل سيجد العقد داخل الصورة،
  لكن البناء نفسه يحتاج التقسية الثلاثية التي ما زلتُ أنتظر إذنك بها.
- **الربط عبر `host.docker.internal`** في compose الجذر لأن الحزمتين منفصلتان. شبكة Docker
  مشتركة أنظف إن أردتَ تشغيلهما معاً لاحقاً.
- **لا إعادة محاولة تلقائية** عند `UNAVAILABLE`. متعمّد: إعادة المحاولة على عملية تكتب
  تحتاج سياسة تراجع أسّي، والـ idempotency موجودة أصلاً لجعلها آمنة لاحقاً.
