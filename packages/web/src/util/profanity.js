/* ═══════════════════════════════════════════════════════════════
   Profanity — офлайн-фильтр нецензурных ников для рейтинга 4+.
   Принципы как у glin-profanity (MIT): нормализация обфускации
   (leetspeak, гомоглифы кириллица↔латиница, повторы, разделители)
   + мультиязычные деny-листы (RU + EN, плюс распространённые слуры).
   API:  Profanity.isClean(name) -> bool ;  Profanity.clean(name, fb)
   Самодостаточно, без зависимостей. © 2026, MIT.
   ═══════════════════════════════════════════════════════════════ */
  // Leetspeak / спецсимволы → буквы.
  const LEET = { '0':'o','1':'i','2':'z','3':'e','4':'a','5':'s','6':'g','7':'t','8':'b','9':'g',
                 '@':'a','$':'s','!':'i','|':'i','+':'t','(':'c','€':'e','£':'l' };
  // Латинские буквы, похожие на кириллицу → кириллица (для русских корней).
  const LAT2CYR = { a:'а', b:'ь', c:'с', e:'е', h:'н', k:'к', m:'м', o:'о', p:'р', t:'т', x:'х', y:'у', i:'и' };
  // Кириллица/греческий, похожие на латиницу → латиница (для англ. корней и транслита).
  const CYR2LAT = { 'а':'a','в':'b','е':'e','к':'k','м':'m','н':'h','о':'o','р':'p','с':'c','т':'t','у':'y','х':'x','і':'i','ѕ':'s','ј':'j',
                    'α':'a','β':'b','ε':'e','κ':'k','ο':'o','ρ':'p','τ':'t','υ':'u','χ':'x','ѡ':'w' };

  function base(s) {
    s = String(s == null ? '' : s).toLowerCase();
    try { s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    s = s.replace(/[​-‏‪-‮⁠﻿]/g, ''); // невидимые
    let out = '';
    for (const ch of s) out += (LEET[ch] !== undefined ? LEET[ch] : ch);
    return out;
  }
  // Сжимаем только «спам-повторы» (3+ одинаковых подряд → 1), НЕ трогая обычные
  // удвоения (asshole, nigger, bitch остаются целыми для точного совпадения).
  function collapse(s) { return s.replace(/(.)\1{2,}/g, '$1'); }

  // Латинская проекция: всё к латинице (англ. + транслит русского).
  function foldLatin(s) {
    let r = '';
    for (const ch of base(s)) r += (CYR2LAT[ch] || ch);
    return collapse(r.replace(/[^a-z0-9]/g, ''));
  }
  // Кириллическая проекция: латиница-похожая к кириллице (русские корни).
  function foldCyr(s) {
    let r = '';
    for (const ch of base(s)) r += (LAT2CYR[ch] || ch);
    return collapse(r.replace(/[^а-яё]/g, ''));
  }

  // ── Деny-листы (корни). Подстрочное совпадение по нормализованной форме. ──
  const BAD_LATIN = [
    // EN — мат и грубости
    'fuck','fuk','fck','fack','phuck','fuxk','fucker','motherfuck','motherfucker','mofo','wtf','stfu',
    'shit','shite','bullshit','dipshit','bitch','biatch','beotch','bastard','asshole','asshat','asswipe','arsehole','dumbass','jackass',
    'azzhole','azzhat','azzwipe','dumbazz','jackazz',
    'bollock','wanker','wank','tosser','prick','twat','bellend','knobhead','douche','douchebag','jerkoff','jackoff',
    // EN — секс / части тела
    'dick','dik','cock','pussy','cunt','kunt','dildo','boner','blowjob','handjob','rimjob','deepthroat','cumshot','cum','jizz','spunk',
    'anal','anus','butthole','arsehole','scrotum','ballsack','nutsack','smegma','queef','clit','penis','vagina','boob','tits','titties','milf','creampie','dickhead',
    // EN — оскорбления
    'whore','slut','skank','thot','hooker','slag',
    // EN — расовые/национальные слуры
    'nigger','nigga','niglet','negro','coon','chink','gook','kike','wetback','beaner','paki','raghead','towelhead','sandnigger',
    // EN — слуры (лгбт/инвалидность)
    'faggot','fagot','fag','dyke','tranny','retard','retarded','spastic','mongoloid',
    // EN — насилие/незаконное/порно/ненависть
    'rape','rapist','molest','pedophile','pedophil','pedo','paedo','incest','bestial','porn','hentai','nsfw','xxx','nazi','hitler','kkk',
    // RU транслит (латиницей) — гейм-слэнг
    'hui','huy','huj','pizda','pizdec','pizdets','blyat','blyad','blya','ebal','eban','ebat','ebuch',
    'zaeb','naeb','mudak','mudila','pidor','pidaras','pidar','gandon','gondon','govno','zalupa','manda',
    'droch','shluha','suka','cyka','suchka','mraz','gnida','vyblyad','ohuel','ahuel','pidr'
  ];
  const BAD_CYR = [
    'хуй','хуё','хуя','хуе','хую','хуи','пизд','бляд','блят','бля','еба','ебa','ёб','ебл','ебу','ебан','ебат','ебуч',
    'заеб','наеб','въеб','уеб','отъеб','подъеб','муда','мудак','мудил','пидор','пидар','пидр','педик','гандон','гондон',
    'говн','дерьм','залуп','манда','дроч','шлюх','сука','сучк','мраз','гнид','выблядок','хер','херн','очко',
    'жопа','жоп','анус','писос','секас','порно','педофил','насил','изнасил',
    'нигг','ниггер','чурк','хач','жид','даун','дебил','уёбок','уебок','долбоёб','долбоеб','еблан','ссан','обоссан'
  ];
  // Безопасные слова, которые иначе ловятся как ложное срабатывание (Scunthorpe-проблема).
  // Проверяется по ПОЛНОМУ совпадению ника с этим словом.
  const ALLOW_LATIN = [
    'class','glass','grass','brass','bass','pass','password','mass','massive','sass','lass','compass','cassie','cass',
    'cucumber','vacuum','circumstance','accumulate','cumulus','succumb','document',
    'analysis','analyst','analytics','analytical','banal','canal',
    'uranus','manuscript',
    'dickens','dickinson','dickson','benedict',
    'peacock','hancock','cockpit','cocktail','cockney','hitchcock','babcock','cockerel',
    'scunthorpe','shiitake','shitake','title','button',
    'raccoon','cocoon','tycoon','negroni',
    'pakistan','pakistani','grape','grapes','grapefruit','grapevine','drape','scrape','trapeze','fagan'
  ];

  function hit(folded, list) { return list.some(w => w && folded.indexOf(w.replace(/\s/g, '')) !== -1); }

  function isClean(name) {
    const fl = foldLatin(name);
    const fc = foldCyr(name);
    if (!fl && !fc) return true;
    // Если всё совпадение объясняется безопасным словом — пропускаем.
    if (ALLOW_LATIN.some(w => fl === w)) return true;
    if (hit(fl, BAD_LATIN)) return false;
    if (hit(fc, BAD_CYR)) return false;
    return true;
  }
  // Вернуть имя, если оно чистое; иначе fallback.
  function clean(name, fb) { return isClean(name) ? name : (fb || ''); }


export { isClean, clean, foldLatin, foldCyr };
