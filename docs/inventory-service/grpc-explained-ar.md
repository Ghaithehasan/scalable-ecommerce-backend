# شرح gRPC — نظرياً وفي كود هذا المشروع

**الغرض:** أن تستطيع شرح gRPC للمعيد، ولماذا اخترناه هنا تحديداً، وأين يظهر في الكود.
**التاريخ:** ٨ تشرين الثاني / نوفمبر ٢٠٢٦

---

## الجزء الأول: النظرية

### ١. ما هو gRPC؟

**gRPC** اختصار لـ *gRPC Remote Procedure Call* (اسم متداخل مع نفسه، أطلقته Google
سنة ٢٠١٦). وهو إطار عمل لاستدعاء **دالّة موجودة في خدمة أخرى** كما لو كانت دالّة محلّية.

الفكرة الأساسية اسمها **RPC** أي *Remote Procedure Call*: بدل أن تفكّر «سأرسل رسالة HTTP
إلى مسار `/reserve` وأقرأ الجواب»، تفكّر «سأنادي `reserveStock(id, items)`». التفاصيل
الشبكية مخفيّة.

في مشروعنا يبدو النداء هكذا في التطبيق الأساسي:

```ts
const response = await this.inventory.reserveStock(reservationId, items);
if (!response.reserved) { ... }
```

لا يوجد `fetch`، ولا `JSON.stringify`، ولا مسار URL. يبدو كاستدعاء دالّة عادية، بينما هو
في الحقيقة رحلة عبر الشبكة إلى عملية أخرى على منفذ آخر.

### ٢. الأركان الثلاثة

#### الركن الأول: العقد (`.proto`)

gRPC يبدأ من **ملف عقد** مكتوب بلغة تُسمّى *Protocol Buffers* (اختصاراً **protobuf**).
هذا الملف هو **مصدر الحقيقة الوحيد** للطرفين:

```proto
service InventoryService {
  rpc ReserveStock(ReserveStockRequest) returns (ReserveStockResponse);
}

message ReserveItem { string product_id = 1; int32 quantity = 2; }
message ReserveStockRequest { string reservation_id = 1; repeated ReserveItem items = 2; }
```

لاحظ **الأرقام** `= 1` و`= 2`. هذه ليست قيماً بل **معرّفات الحقول على السلك**. فعند
التسلسل لا يُرسَل اسم الحقل `product_id` إطلاقاً، بل يُرسَل الرقم `1`. ولهذا:

- الرسالة أصغر بكثير من JSON.
- **يمكنك إعادة تسمية الحقل** من دون كسر أحد، ما دام الرقم ثابتاً.
- **لا يمكنك إعادة استعمال رقم** لحقل آخر — سيفسّر الطرف الآخر البايتات خطأً.

#### الركن الثاني: Protobuf كصيغة تسلسل

JSON نصّي: يُرسل أسماء الحقول في كل رسالة، والأرقام كنصوص.
Protobuf **ثنائي**: يرسل أرقام الحقول وقيمها بترميز مضغوط.

```
JSON    : {"reservationId":"a3f","items":[{"productId":"1","quantity":2}]}   ≈ 62 بايت
Protobuf: 0A 03 61 33 66 12 05 0A 01 31 10 02                                ≈ 12 بايت
```

الفرق ليس الحجم فقط، بل أن التحليل (parsing) أسرع لأن المستقبل لا يبحث عن أسماء نصّية.

#### الركن الثالث: HTTP/2 كطبقة نقل

gRPC يعمل فوق **HTTP/2** لا HTTP/1.1، وهذا يعطيه:

| الميزة | المعنى |
| --- | --- |
| **Multiplexing** | عدّة نداءات متزامنة على **اتصال TCP واحد** بلا انتظار دورها |
| **ترويسات مضغوطة** (HPACK) | لا تتكرّر الترويسات مع كل نداء |
| **Streaming ثنائي الاتجاه** | يمكن للطرفين إرسال تيّار من الرسائل |
| **Deadlines** | مفهوم أصيل في البروتوكول لا اصطلاح من عندنا |

في عرض التسابق أرسلنا ٥٠ نداء حجز متزامناً في **236 مللي ثانية** — وكلها سافرت على
اتصال واحد بفضل الـ multiplexing.

### ٣. أنواع النداءات الأربعة

| النوع | الوصف | استعمالنا |
| --- | --- | --- |
| **Unary** | طلب واحد ← جواب واحد | ✅ عملياتنا الثلاث كلها |
| Server streaming | طلب واحد ← تيّار أجوبة | ✗ |
| Client streaming | تيّار طلبات ← جواب واحد | ✗ |
| Bidirectional | تيّاران متزامنان | ✗ (لكن reflection يستعمله) |

### ٤. رموز الحالة

gRPC لا يستعمل رموز HTTP، بل **١٧ رمزاً خاصاً به**. التي تهمّنا:

| الرمز | الاسم | عندنا |
| --- | --- | --- |
| 0 | `OK` | نجاح |
| 3 | `INVALID_ARGUMENT` | معرّف حجز فارغ، كمية ≤ 0، منتج مكرّر |
| 4 | `DEADLINE_EXCEEDED` | المستودع لم يردّ خلال المهلة |
| 5 | `NOT_FOUND` | منتج لا يعرفه المستودع |
| 9 | `FAILED_PRECONDITION` | حجز سبق تحريره |
| 13 | `INTERNAL` | خطأ غير متوقّع |
| 14 | `UNAVAILABLE` | الخدمة متوقّفة |

### ٥. gRPC مقابل REST — ولماذا اخترناه هنا

| | REST / JSON | gRPC |
| --- | --- | --- |
| العقد | اصطلاح أو OpenAPI (اختياري) | **ملف `.proto` إلزامي** |
| الصيغة | نصّية | ثنائية مضغوطة |
| النقل | HTTP/1.1 غالباً | HTTP/2 |
| توليد الكود | غالباً يدوي | **تلقائي للطرفين** |
| Deadlines | اصطلاح يدوي | **أصيل في البروتوكول** |
| قابلية القراءة بالمتصفّح | ممتازة | تحتاج أداة |

**لماذا هو المناسب هنا:**

1. **تواصل خدمة ↔ خدمة، لا متصفّح ↔ خادم.** لا أحد يفتح المستودع في متصفّح، فميزة REST
   الكبرى (القابلية للقراءة) لا قيمة لها هنا، وميزة gRPC (السرعة والعقد الصارم) ثمينة.
2. **العقد يمنع الانحراف.** لو غيّرتُ اسم دالّة في المستودع، **توقّف ترجمة** التطبيق
   الأساسي فوراً. مع REST كنت سأكتشفها وقت التشغيل.
3. **الـ deadline جزء من البروتوكول** — وهو بالضبط ما تطلبه الكرّاسة: «لا ينتظر المستخدم
   بلا نهاية».
4. **مطلب الكرّاسة صراحةً**: «يتواصل معها التطبيق عن طريق gRPC بشكل مباشر».

**وأين لا يناسب:** واجهة التطبيق مع المتصفّح بقيت REST + JSON، وهذا صحيح: الزبون يفتحها
في متصفّح ويحتاج قراءتها.

---

## الجزء الثاني: gRPC في كود هذا المشروع

### ١. العقد

[`proto/inventory/v1/inventory.proto`](../../proto/inventory/v1/inventory.proto)

يقع في **جذر المستودع** لا داخل أي خدمة — لأنه ملك الطرفين. الخدمتان تقرآنه، ولا تنسخه
أيٌّ منهما.

```
proto/inventory/v1/inventory.proto       ← مصدر الحقيقة
    ├─► inventory-service/src/generated/      (أنواع الخادم)
    └─► src/inventory/generated/              (أنواع العميل)
```

لاحظ `v1` في المسار: إصدار العقد. لو احتجنا تغييراً كاسراً لاحقاً أنشأنا `v2` وشغّلناهما
معاً أثناء الترحيل.

### ٢. توليد الأنواع

كلا المشروعين يملك `buf.gen.yaml` متطابقاً:

```yaml
version: v2
plugins:
  - local: protoc-gen-ts_proto
    out: src/generated
    opt:
      - nestJs=true
      - outputEncodeMethods=false      # ← مهم، انظر أدناه
      - outputJsonMethods=false
      - outputClientImpl=false
```

يُنفَّذ بـ `npm run proto:generate`، والناتج **مُودَع في Git** حتى لا تحتاج صورة Docker
إلى `buf` ولا `ts-proto`.

**لماذا أُلغيت دوالّ encode/decode؟** لأن التسلسل الفعلي يقوم به `@grpc/proto-loader` وقت
التشغيل (يقرأ `.proto` مباشرةً)، فدوالّ ts-proto شيفرة ميتة تجرّ معها اعتماد
`@bufbuild/protobuf`. وبإلغائها نزل الملف من **٦٦٨ إلى ١١٧ سطراً** وصار يستورد شيئين فقط.

### ٣. جهة الخادم — خدمة المستودع

**أ. الإقلاع كخدمة مصغّرة** — `inventory-service/src/main.ts:47`

```ts
const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
  transport: Transport.GRPC,
  options: {
    url: `${env.GRPC_HOST}:${env.GRPC_PORT}`,     // 0.0.0.0:50051
    package: INVENTORY_V1_PACKAGE_NAME,           // "inventory.v1"
    protoPath: resolveInventoryProtoPath(),
    loader: { keepCase: false, defaults: true, oneofs: true, includeDirs: [protoDir] },
    gracefulShutdown: true,
    onLoadPackageDefinition: (pkg, server) => registerGrpcServerExtras(pkg, server),
  },
  logger: parseLogLevels(env.LOG_LEVELS),
});
```

ثلاث نقاط تستحقّ الذكر:

- `createMicroservice` ليس خادم HTTP. لا مسارات ولا `@Get`؛ خادم gRPC محض.
- `keepCase: false` يحوّل `product_id` في العقد إلى `productId` في JavaScript. **ويجب أن
  يتطابق الخيار على الطرفين** وإلا اختلفت أسماء الحقول.
- `defaults: true` يجعل القيم الصفرية حاضرة، فتصل `[]` بدل `undefined`.

**ب. المتحكّم** — `inventory-service/src/inventory/inventory.controller.ts:32`

```ts
@Controller()
@InventoryServiceControllerMethods()          // ← مولَّد من العقد
export class InventoryController implements InventoryServiceController {
  reserveStock(@Payload() request: ReserveStockRequestDto): Promise<ReserveStockResponse> {
    return this.inventoryService.reserveStock(request);
  }
}
```

المزخرِف المولَّد يطبّق `@GrpcMethod('InventoryService', 'reserveStock')` على كل دالّة.
وبما أن الصنف يُنفّذ `InventoryServiceController`، فإن أي انحراف عن العقد **يوقف الترجمة**.

> **فخّ اكتشفناه:** `@Payload()` ليست تجميلاً. TypeScript لا يُصدِر `design:paramtypes`
> إلا إذا كان للدالّة أو لأحد وسطائها مزخرِف **في الشيفرة المصدرية**. والمزخرِف المولَّد
> مزخرِف **صنف**، فلا يكفي. من دون `@Payload()` يتلقّى `ValidationPipe` قيمة
> `metatype === undefined` **فيتخطّى التحقّق بصمت تام**. أثبتناه بحذفها فمرّت المدخلات
> الفاسدة إلى المعالج.

**ج. الأخطاء** — `inventory-service/src/common/filters/rpc-exception.filter.ts`

```ts
throw new RpcException({ code: status.INVALID_ARGUMENT, message: '...' });
```

`ValidationPipe` الافتراضي يرمي `BadRequestException` (مفهوم HTTP) ولا يعرفه نقل gRPC
فيحوّله إلى `UNKNOWN` (2). ولهذا كتبنا `exceptionFactory` مخصّصاً يرمي
`INVALID_ARGUMENT` (3).

**د. إضافتان قياسيتان** — `grpc-server-extras.ts`

| الخدمة | الفائدة |
| --- | --- |
| `grpc.health.v1.Health` | فحص سلامة الحاوية (`dist/healthcheck.js`) |
| `ServerReflection` | يتيح لـ grpcurl اكتشاف الواجهة **بلا نسخة من `.proto`** |

### ٤. جهة العميل — التطبيق الأساسي

[`src/inventory/inventory.client.ts`](../../src/inventory/inventory.client.ts)

```ts
onModuleInit(): void {
  const definition = protoLoader.loadSync(protoPath, {
    keepCase: false, defaults: true, oneofs: true,   // ← نفس خيارات الخادم
    includeDirs: [resolveProtoDir()],
  });
  const pkg = grpc.loadPackageDefinition(definition);
  this.client = new pkg.inventory.v1.InventoryService(url, grpc.credentials.createInsecure());
}
```

**قناة واحدة لكل العملية** لا قناة لكل نداء — وهذا جوهر فائدة HTTP/2: الاتصال يُفتح مرّة
وتتشاركه كل النداءات.

> `createInsecure()` بلا TLS لأن الخدمتين على شبكة داخلية. في الإنتاج الحقيقي تُستعمل
> `credentials.createSsl()`. نقطة صدق تستحقّ الذكر للمعيد.

**الـ deadline** — `inventory.client.ts:143`

```ts
client[method](
  payload,
  { deadline: new Date(Date.now() + timeoutMs) },   // ← ميزة أصيلة في gRPC
  (error, value) => (error ? reject(error) : resolve(value)),
);
```

ثلاث مهل مختلفة لأن العمليات ليست متساوية: قراءة 1500ms · حجز 3000ms · **تحرير 5000ms**
(تعويض يعمل بعد فشلٍ أصلاً فلا يرث مهلةً منتهية).

> **أهم ما تعلّمناه عن الـ deadline:** هي **استسلام من جهة العميل فقط**. الخادم لا يلتزم
> بإلغاء عمله. أثبتناه: نداء بمهلة ٣٠٠ms على خدمة تتأخّر ١٥٠٠ms أعاد `DEADLINE_EXCEEDED`
> للعميل، ثم **أكمل الخادم الحجز فعلاً** بعدها. ولهذا التعويض إلزامي، ولهذا وُجدت شاهدة
> القبر.

### ٥. رحلة بايتات واحدة — مثال كامل

```
التطبيق الأساسي                                      المستودع
─────────────                                      ─────────
reserveStock('a3f-...', [{ productId: '1', quantity: 2 }])
      │
      │ ① ts-proto يضمن الأنواع وقت الترجمة
      │ ② proto-loader يسلسل إلى protobuf ثنائي
      │ ③ إطار HTTP/2 على المسار:
      │    POST /inventory.v1.InventoryService/ReserveStock
      │    grpc-timeout: 3000m      ← الـ deadline يسافر مع الطلب
      │
      ├──────────── TCP (اتصال واحد مُعاد استعماله) ────────────►
      │                                                   ④ فكّ التسلسل
      │                                                   ⑤ ValidationPipe
      │                                                   ⑥ @GrpcMethod يوجّه
      │                                                   ⑦ UPDATE شرطي في معاملة
      │                                                   ⑧ تسلسل الجواب
      ◄──────────── grpc-status: 0 + الجسم الثنائي ───────────────┤
      │
      ⑨ { reserved: true, shortages: [] }
```

عند الفشل يُستبدل ⑨ بـ `grpc-status: 14` مثلاً، فيلتقطه `mapGrpcError` ويترجمه إلى
`503` للعميل.

---

## أسئلة متوقّعة من المعيد

**«لماذا لا REST بين الخدمتين؟»**
لأن هذا تواصل آلة↔آلة لا إنسان↔آلة. العقد الصارم المولَّد يمنع انحراف الواجهتين، والـ
deadline مدمج في البروتوكول، والتسلسل الثنائي أسرع. ولأن الكرّاسة تطلب gRPC صراحةً.

**«ماذا لو تغيّر العقد؟»**
إضافة حقل جديد برقم جديد **متوافقة رجعياً**: الطرف القديم يتجاهله. التغيير الكاسر (حذف
حقل أو تغيير نوعه أو إعادة استعمال رقم) يحتاج `v2` بجوار `v1`.

**«أين الـ proto بالضبط ولماذا؟»**
في `proto/` بجذر المستودع. لو وضعناه داخل إحدى الخدمتين لصارت الأخرى تابعة لها، ولو نسخناه
مرّتين لانحرفت النسختان بصمت.

**«كيف تعرف أن الواحد فقط ينجح على آخر قطعة؟»**
ليس بسبب gRPC بل بسبب قاعدة البيانات: `UPDATE ... WHERE available >= $q` عبارة واحدة
ذرّية، وتحت عزل READ COMMITTED تُعيد المعاملة المنتظرة تقييم الشرط بعد القفل. و gRPC
مجرّد وسيلة نقل. (انظر [خريطة سير الطلب](order-flow-ar.md)، المحطّة ٤.)

**«ماذا لو تعطّل المستودع؟»**
`UNAVAILABLE` (14) ← يترجمها `mapGrpcError` إلى **503** برسالة صريحة «لم يُنشَأ طلبك».
والكتالوج يبقى يعمل بـ `stock: null`. مُبرهَن في العرض الحيّ.

**«هل جرّبتَ الواجهة بأداة؟»**
نعم: server reflection مُفعَّل، فـ grpcurl يكتشف العمليات بلا نسخة من `.proto`. وبما أن
grpcurl غير مثبّت هنا كتبنا `npm run probe` يؤدّي الشيء نفسه ببروتوكول reflection الحقيقي.

---

**اقرأ أيضاً:** [خريطة سير الطلب](order-flow-ar.md) · [خطوات التجريب اليدوي](manual-testing-ar.md)
