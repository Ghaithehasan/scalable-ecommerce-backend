# التجريب اليدوي — حالات الفشل الثلاث في المتطلّب الثاني

**الغرض:** خطوات منسوخة حرفياً لتجريب الحالات الثلاث بيدك أمام المعيد.
**التاريخ:** ٨ تشرين الثاني / نوفمبر ٢٠٢٦
**كل المخرجات أدناه حقيقية**، التُقطت من تشغيل فعلي.

> الأوامر مكتوبة لـ **Git Bash**. إن كنتَ في PowerShell فاستعمل ملفات
> [`http/`](../../http/) مع إضافة REST Client بدل `curl` — وفيها
> [`http/requirement2.http`](../../http/requirement2.http) مخصّص لهذه الحالات.

---

## التحضير (مرّة واحدة)

### ١. شغّل كل شيء

```bash
# المستودع وقاعدته
cd inventory-service && docker compose up -d && cd ..

# قاعدة التطبيق الأساسي
docker compose up -d postgres

# التطبيق الأساسي
npm run build && node dist/main
```

تأكّد أن الثلاثة تعمل:

```bash
cd inventory-service && docker compose ps && cd ..
curl -s -o /dev/null -w "main app: %{http_code}\n" http://127.0.0.1:3000/auth/me   # 401 = يعمل
```

### ٢. احصل على رمز دخول

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Demo\",\"email\":\"demo.$(date +%s)@example.com\",\"gender\":\"MALE\",\"password\":\"DemoPass123!\"}" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).accessToken))")

echo $TOKEN
```

### ٣. اعرف معرّفات منتجاتك

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3000/products?limit=10" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(r.data.map(p=>({id:p.id,name:p.name,stock:p.stock})))})"
```

سمِّ المعرّف الذي ستستعمله `PID` (مثلاً `2`):

```bash
PID=2
```

### ٤. اضبط مخزونه

المستودع يفهرس بـ **معرّف المنتج كنصّ**:

```bash
cd inventory-service
docker compose exec -T inventory-postgres psql -U postgres -d inventory \
  -c "INSERT INTO stock (product_id, available, reserved) VALUES ('$PID', 10, 0)
      ON CONFLICT (product_id) DO UPDATE SET available=10, reserved=0"
cd ..
```

### دالّة مساعدة لقراءة المخزون

```bash
stock() { (cd inventory-service && docker compose exec -T inventory-postgres \
  psql -U postgres -d inventory -c \
  "SELECT product_id, available, reserved FROM stock WHERE product_id='$1'"); }
```

---

## الحالة ١ — الكمية غير كافية

> **المطلوب:** «الكمية غير كافية: يُرفض الطلب برسالة واضحة.»

**الفكرة:** اطلب أكثر مما في المستودع، لكن **ضمن الحدّ المسموح لكل سطر (١٠٠٠)**. فطلب
`999999` يُرفض بـ `400` من تحقّق المتطلّب الأول قبل أن يصل أي نداء gRPC — وهو ترتيب صحيح
(التحقّق المحلّي الرخيص أولاً) لكنه لا يُجرّب المستودع.

```bash
stock $PID                 # available = 10

curl -s -w "\nHTTP:%{http_code}\n" -X POST http://127.0.0.1:3000/orders \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"items\":[{\"productId\":$PID,\"quantity\":11}]}"
```

**الناتج المتوقَّع:**

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "message": "Some items are no longer available in the requested quantity",
  "shortages": [{ "productId": 2, "requested": 11, "available": 10 }],
  "path": "/orders",
  "timestamp": "..."
}
HTTP:409
```

**تحقّق أن شيئاً لم يتغيّر:**

```bash
stock $PID                 # ما زال 10 / 0 — المعاملة تراجعت بالكامل
```

### ما تشرحه هنا

- **٤٠٩ لا ٥٠٠**: نفاد المخزون **نتيجة تجارية** لا خطأ تقني. النداء نجح، والبضاعة ناقصة.
- **`shortages` تسمّي كل صنف ناقص** وما طُلب وما تبقّى — فيصلح الزبون سلّته مرّة واحدة بدل
  اكتشاف المشاكل صنفاً صنفاً.
- **الكل-أو-لا-شيء**: جرّب سلّة فيها صنف كافٍ وآخر ناقص، وسترى أن الكافي **لم يُخصَم**:

```bash
curl -s -X POST http://127.0.0.1:3000/orders \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"items\":[{\"productId\":$PID,\"quantity\":1},{\"productId\":$PID,\"quantity\":1}]}"
# 400: المنتج مكرّر — استعمل معرّفين مختلفين لتجربة الكل-أو-لا-شيء
```

---

## الحالة ٢ — المستودع متوقّف أو لا يردّ خلال مهلة

> **المطلوب:** «خدمة المستودع متوقفة أو لا ترد خلال مهلة محددة: لا ينتظر المستخدم بلا
> نهاية، ويحصل على خطأ واضح.»

وهذان سيناريوهان مختلفان، جرّبهما معاً.

### ٢-أ: الخدمة **متوقّفة** → `UNAVAILABLE` (14) → **503**

```bash
cd inventory-service && docker compose stop inventory && cd ..

curl -s -w "\nHTTP:%{http_code}\n" -X POST http://127.0.0.1:3000/orders \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"items\":[{\"productId\":$PID,\"quantity\":1}]}"
```

**الناتج الفعلي:**

```json
{
  "statusCode": 503,
  "error": "Service Unavailable",
  "message": "The inventory service is unavailable. Your order was not placed; please try again shortly.",
  "path": "/orders",
  "timestamp": "2026-11-08T13:34:35.068Z"
}
HTTP:503
```

**والكتالوج يبقى يعمل** — وهذه نقطة تصميم مهمّة:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/products/$PID \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d);console.log('HTTP ok, name:',p.name,'| stock:',p.stock)})"
# → HTTP ok, name: ... | stock: null
```

أعِد التشغيل:

```bash
cd inventory-service && docker compose start inventory && cd ..
```

### ٢-ب: الخدمة **بطيئة** → `DEADLINE_EXCEEDED` (4) → **503**

شغّل المستودع بتأخير اصطناعي ٦ ثوانٍ، بينما ميزانية العميل ٣ ثوانٍ:

```bash
cd inventory-service
INVENTORY_ARTIFICIAL_DELAY_MS=6000 docker compose up -d inventory
cd ..
sleep 10

stock $PID        # سجّل القيمة قبل

time curl -s -w "\nHTTP:%{http_code}\n" -X POST http://127.0.0.1:3000/orders \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"items\":[{\"productId\":$PID,\"quantity\":3}]}"
```

**الناتج الفعلي:**

```json
{
  "statusCode": 503,
  "error": "Service Unavailable",
  "message": "The inventory service did not respond in time. Your order was not placed; please try again shortly.",
  ...
}
HTTP:503
elapsed: 3150 ms          ← لم ينتظر الستّ ثوانٍ
```

**الآن أهم فحص في هذا السيناريو كلّه.** انتظر عشر ثوانٍ ثم:

```bash
sleep 10
stock $PID        # يجب أن يكون كما كان تماماً — لا تسرّب
```

أعِد السرعة الطبيعية:

```bash
cd inventory-service && INVENTORY_ARTIFICIAL_DELAY_MS=0 docker compose up -d inventory && cd ..
```

### ما تشرحه هنا

- **المهلة ميزة أصيلة في gRPC** لا شيء اخترعناه: ترويسة `grpc-timeout` تسافر مع الطلب.
- **الزبون انتظر 3.15 ثانية لا 6** — وهذا نصّ المطلوب: «لا ينتظر بلا نهاية».
- **والنقطة الدقيقة التي تميّز الإجابة:** مهلة gRPC توقف انتظار **العميل** فقط؛ الخادم
  **يُكمل عمله**. فذلك الحجز نجح فعلاً عند الثانية السادسة. والسبب في بقاء المخزون سليماً
  هو **شاهدة القبر**: التحرير التعويضي وصل أولاً وسجّل أن هذا المعرّف صار `RELEASED`،
  فلمّا وصل الحجز المتأخّر **رُفض** بـ `FAILED_PRECONDITION`.

تأكّد منها في السجلّ:

```bash
grep -oE "Released reservation [0-9a-f-]+ after a failure \(released=[a-z]+\)" ~/main-app.log | tail -1
# Released reservation 031aa3ba-... after a failure (released=false)
#                                                            ↑
#              false = لم يكن هناك حجز بعد، فكُتبت شاهدة قبر
```

---

## الحالة ٣ — الحجز نجح ثم فشل حفظ الطلب

> **المطلوب:** «تم الحجز ثم فشل حفظ الطلب: تُرجع الكمية المحجوزة إلى المستودع.»

**كيف نُجبر هذا السيناريو بيدنا؟** نحتاج طلباً **ينجح حجزه** ثم **يفشل حفظه**. وأبسط طريقة
نظيفة: منتج موجود في **المستودع** وغير موجود في **الكتالوج**. فالحجز يمرّ (المستودع يعرفه)
ثم تفشل كتابة الطلب (الكتالوج لا يعرفه) — وهو انحراف واقعي بين النظامين.

### الخطوات

```bash
# ١) أضف مخزوناً لمعرّف غير موجود في الكتالوج
cd inventory-service
docker compose exec -T inventory-postgres psql -U postgres -d inventory \
  -c "INSERT INTO stock (product_id, available, reserved) VALUES ('9999', 10, 0)
      ON CONFLICT (product_id) DO UPDATE SET available=10, reserved=0"
cd ..

# ٢) سجّل الحالة قبل
stock 9999
```

```
 product_id | available | reserved
------------+-----------+----------
 9999       |        10 |        0
```

```bash
# ٣) اطلبه
curl -s -w "\nHTTP:%{http_code}\n" -X POST http://127.0.0.1:3000/orders \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"items":[{"productId":9999,"quantity":3}]}'
```

**الناتج الفعلي:**

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "Product with id 9999 not found",
  "path": "/orders",
  "timestamp": "2026-11-08T14:32:21.458Z"
}
HTTP:404
```

```bash
# ٤) الفحص الحاسم: هل عادت الكمية؟
stock 9999
```

```
 product_id | available | reserved
------------+-----------+----------
 9999       |        10 |        0          ← عادت كما كانت
```

```bash
# ٥) وهل سُجّل التحرير؟
cd inventory-service
docker compose exec -T inventory-postgres psql -U postgres -d inventory \
  -c "SELECT id, status FROM reservations ORDER BY created_at DESC LIMIT 1"
cd ..
```

```
                  id                  |  status
--------------------------------------+----------
 d917fc33-5fc8-41bb-83f0-ac1bd3662b51 | RELEASED
```

```bash
grep -oE "Released reservation [0-9a-f-]+ after a failure \(released=[a-z]+\)" ~/main-app.log | tail -1
# Released reservation d917fc33-5fc8-41bb-83f0-ac1bd3662b51 after a failure (released=true)
#                                                                                    ↑
#                                 true = كان هناك حجز فعلي، وقد أُعيدت وحداته
```

### ما تشرحه هنا

- **التسلسل:** حُجزت ٣ وحدات فعلاً (`available` صار 7 للحظة)، ثم فشل حفظ الطلب، فنادى
  `compensate()` عملية `ReleaseStock` بـ **نفس المعرّف**، فعادت إلى 10.
- **`released=true`** هنا مقابل **`released=false`** في الحالة ٢-ب. الفرق جوهري:
  `true` = كان هناك حجز فأُعيد · `false` = لم يكن، فكُتبت شاهدة قبر.
- **التعويض لا يرمي أبداً**: الزبون تلقّى `404` عن المشكلة الأصلية، لا خطأً عن فشل التنظيف.

### تنظيف

```bash
cd inventory-service
docker compose exec -T inventory-postgres psql -U postgres -d inventory \
  -c "DELETE FROM stock WHERE product_id='9999'"
cd ..
```

---

## الإثبات الرابع — التسابق على آخر قطعة

> **المطلوب:** «يرسل عدة طلبات في نفس اللحظة على آخر قطعة، طلب واحد فقط ينجح.»

```bash
# اضبط المنتج على وحدة واحدة
cd inventory-service
docker compose exec -T inventory-postgres psql -U postgres -d inventory \
  -c "UPDATE stock SET available=1, reserved=0 WHERE product_id='$PID'"
cd ..

# أرسل ٢٠ طلباً متزامناً
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3000/orders \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"items\":[{\"productId\":$PID,\"quantity\":1}]}" &
done | sort | uniq -c
wait

stock $PID      # available 0, reserved 1
```

**أو — وهو الأنظف للعرض — السكربت الجاهز الذي يفعل هذا وكل ما سبق:**

```bash
npm run demo:req2 -- 30
```

ويطبع جدولاً نهائياً:

```
  201 Created  : 1
  409 Conflict : 29
  anything else: 0
  elapsed      : 235 ms
  PASS  the ledger balances: available 0, reserved 1
```

---

## جدول مرجعي سريع

| ماذا تريد أن تُظهر | الأمر | المتوقَّع |
| --- | --- | --- |
| الكمية مع تفاصيل المنتج | `GET /products/:id` | `"stock": {"available":…}` |
| كمية غير كافية | طلب كمية > المتاح (≤1000) | **409** + `shortages` |
| المستودع متوقّف | `docker compose stop inventory` | **503** «لم يُنشَأ طلبك» |
| المستودع بطيء | `INVENTORY_ARTIFICIAL_DELAY_MS=6000` | **503** بعد ~3s لا 6s |
| الحجز نجح والحفظ فشل | منتج في المستودع وليس في الكتالوج | **404** والمخزون يعود |
| التسابق | ٢٠ طلباً متزامناً على وحدة واحدة | `1×201` و`19×409` |
| كل ما سبق دفعةً واحدة | `npm run demo:req2 -- 30` | `ALL CHECKS PASSED` |

---

**اقرأ أيضاً:** [خريطة سير الطلب](order-flow-ar.md) · [شرح gRPC](grpc-explained-ar.md)
