# ملفات اللغة — CineAura language files

كل لغة لها ملف واحد بصيغة `.lng` بداخله خريطة الترجمة. النص الإنجليزي هو **المفتاح**،
لأن الإنجليزية هي اللغة الافتراضية للموقع، والقيمة هي الترجمة:

```
Free = مجاني
Search = بحث
Movies = أفلام
Series = مسلسلات
IPTV = الايبي تي في
Plans & Pricing = الباقات والأسعار
Support = الدعم
```

## الملفات

| اللغة | الكود | الملف |
| --- | --- | --- |
| English (افتراضية) | `en` | `lang/english.lng` |
| العربية | `ar` | `lang/arabic.lng` |
| Français | `fr` | `lang/french.lng` |
| Deutsch | `de` | `lang/german.lng` |
| Español | `es` | `lang/spanish.lng` |
| Nederlands | `nl` | `lang/dutch.lng` |
| Italiano | `it` | `lang/italian.lng` |

`english.lng` هو القائمة الكاملة للمفاتيح (كل قيمة فيه تساوي مفتاحها)، ويُستخدم كمرجع
للمفاتيح المتوفرة.

## الصيغة

* سطر واحد لكل ترجمة بالشكل: `النص الإنجليزي = الترجمة`.
* الأسطر التي تبدأ بـ `#` تعليقات ويتم تجاهلها.
* إذا احتوى المفتاح على علامة `=` تُكتب مسبوقة بشرطة مائلة `\=` (مثال رابط قائمة M3U).
* أي مفتاح غير موجود في الملف يعود الموقع تلقائيًا إلى النص الإنجليزي.
* البحث غير حسّاس لحالة الأحرف (`active` تساوي `Active`)، ويتم تجاهل رموز HTML
  (`Plans &amp; Pricing` تُطابق `Plans & Pricing`).
* مواضع المتغيرات `{n}` و`{name}` و`{date}` تُكتب كما هي في القيمة أيضًا.

## ماذا يوجد داخل كل ملف؟

1. **واجهة الموقع** — كل جملة أو كلمة تظهر في الصفحات (القوائم، الصفحة الرئيسية،
   لوحة التحكم، الملف الشخصي، صفحة المشاهدة، بانل الطاقم …).
2. **قيم قاعدة بيانات Supabase** — القيم الخام المخزّنة في الجداول، مثل حالة العضو
   (`active` / `disabled` / `banned` / `blocked`)، نوع العضوية (`Free` / `Silver` /
   `Gold` / `Diamond`)، الدور (`super` / `admin` / `moderator`)، الظهور
   (`public` / `exclusive` / `private`)، سبب البلاغ (`misleading` / `broken` /
   `malicious` / `stolen` / `bad` / `indirect`)، حالة الرمز (`active` / `disabled` /
   `banned` / `expired`)، نوع IPTV (`free` / `premium` / `xtream` / `m3u`) …

## كيف تعمل؟

* `js/i18n.js` يحمل فهرس المفاتيح فقط: `مفتاح الواجهة → النص الإنجليزي` (مثال
  `"nav.search": "Search"`). هذا الفهرس هو ما تستخدمه الصفحات: `CineAura.t("nav.search")`.
* `js/lang.js` يقرأ ملف اللغة الحالية `lang/<language>.lng`، يبني منه خريطة
  «إنجليزي → ترجمة»، ثم يعبّئ كل مفاتيح الواجهة بالترجمة، ويكرّر ترجمة الصفحة عند وصول
  الملف.
* الملف يُحفَظ في `localStorage` (المفتاح `cineaura_lng_<code>`) ليعمل الموقع بسرعة عند
  الزيارة التالية، ثم يُحدَّث من السيرفر عند كل تحميل.
* إذا فشل تحميل الملف (مثلاً فُتحت الصفحات بدون سيرفر) يبقى الموقع بالإنجليزية.

### واجهة الاستخدام في الجافاسكربت

```js
CineAura.t("nav.search");          // مفاتيح الواجهة (كما هو الحال سابقًا)
CineAura.tr("Free");               // أي نص إنجليزي: قيمة من Supabase مثلًا
CineAuraText("banned");            // المكافئ المختصر: "محظور" بالعربية
CineAuraLang.text("premium");      // من الخريطة مباشرة
CineAuraLang.load("fr");           // تحميل لغة أخرى (يحدث تلقائيًا عند تبديل اللغة)
```

كل عنصر في HTML يحمل `data-i18n="key"` أو `data-i18n-placeholder="key"` أو
`data-i18n-aria="key"` أو `data-i18n-title="key"` يُترجم تلقائيًا عند التحميل، وتُعاد
ترجمته بعد وصول ملف اللغة.

## تعديل ترجمة

افتح ملف اللغة وعدّل القيمة بعد علامة `=`. لا تحتاج أي شيء آخر — الملف يُقرأ عند كل
تحميل للصفحة، وذاكرة المتصفح تُحدَّث تلقائيًا.

## إضافة لغة جديدة

1. أنشئ ملفًا جديدًا بنفس النسق (يمكن نسخ `english.lng`) باسم اللغة، مثل `lang/portuguese.lng`.
2. أضف الكود والملف في `js/lang.js` داخل `FILES`:

   ```js
   pt: "portuguese",
   ```

3. أضف الكود `"pt"` إلى قائمة `LANGS` في `js/i18n.js`، وإلى قوائم اللغات في
   `js/prefs.js` و`js/common.js` (`LANGS` و`TMDB_LANG` و`LOCALE`).
4. أضف اسم اللغة في كل ملفات اللغة عند المفتاح `Language` (مثال `English = الإنجليزية`).

## CineAura language files (English summary)

Every language is one plain-text `.lng` map where the English text is the key and the
value is the translation. `english.lng` is the master key list. `js/i18n.js` now holds only
the key → English index used by `CineAura.t()`, while `js/lang.js` loads
`lang/<language>.lng`, fills the dictionary for that language and re-translates the page.
The same map translates text coming from Supabase (`CineAura.tr("Silver")`,
`CineAuraLang.text("banned")`). Lookups ignore case and HTML entities; missing entries fall
back to English.
