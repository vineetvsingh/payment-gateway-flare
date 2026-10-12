/*
 * Getting Hindi and Hinglish read aloud properly.
 *
 * English voices mangle Hinglish ("bhai" comes out as "buy"), and Hindi voices only pronounce Hindi
 * properly when it's written in Devanagari. So a message that is Hindi or Hinglish is rewritten for a
 * Hindi voice: the Hindi words in Latin letters become Devanagari, and the English words stay as they
 * are, which Hindi voices like Edge's Swara and Madhur read as English. "Bhai aaj ka stream mast hai"
 * becomes "भाई आज का stream मस्त है".
 */

/**
 * Common Hinglish words with the spellings people actually type, and how they're written in Devanagari.
 * None of these is also an English word, so finding them is what marks a message as Hinglish.
 */
const HINDI_WORDS = `
bhai,bhaii=भाई; bhaiya,bhaiyya,bhaiyaa=भैया; didi,dii=दीदी; yaar,yar,yaara=यार; dost=दोस्त; dosto,doston=दोस्तों
kya,kyaa,kia=क्या; kyu,kyun,kyon,kiu,kyoon=क्यों; kyunki,kyuki,kyonki,kyuke=क्योंकि; kaise,kese,kaisey=कैसे; kaisa,kesa=कैसा
kaisi,kesi=कैसी; kaun,kon=कौन; kab=कब; kahan,kahaan,kaha=कहाँ; kitna=कितना; kitne=कितने; kitni=कितनी; kuch,kuchh,kuj=कुछ
koi=कोई; kabhi,kbhi=कभी; abhi,abi,abhie=अभी; phir,fir,phirse,firse=फिर; jaldi=जल्दी; hamesha,hmesha,humesha=हमेशा; aaj,aj=आज
kal=कल; roz,roj=रोज़; raat=रात; subah=सुबह; shaam,sham=शाम; saal=साल; ghar=घर
hai,hain,hein=है; hu,hoon,hun=हूँ; tha=था; thi=थी; hoga=होगा; hogi=होगी; honge=होंगे; hota=होता; hoti=होती; hote=होते
nahi,nahin,nhi,nai,nahee,nahii=नहीं; haan,haa,haanji=हाँ; ji,jii=जी; bilkul=बिल्कुल; ekdum,ekdam=एकदम; pakka,pkka=पक्का
zaroor,zarur,jaroor,jarur=ज़रूर; sach=सच; sachi,sacchi,sachchi=सच्ची; sachme,sachmein=सच में; matlab,mtlb=मतलब
bahut,bohot,bohat,bhot,bahot,bht,bhut,bhaut=बहुत; thoda,thora=थोड़ा; thodi,thori=थोड़ी; zyada,jyada,jada,zada=ज़्यादा
sabse,sbse=सबसे; sab,sabh=सब; sabko,sbko=सबको; sabhi=सभी; sirf=सिर्फ; bhi,bi=भी; aur=और; lekin,lkin=लेकिन; magar=मगर
agar=अगर; isliye,isliya=इसलिए; warna,varna=वरना; toh=तो; ke=के; ki=की; ka=का; ko=को; se=से; ne=ने; mein,mei=में
pe=पे; liye=लिए; wala,waala=वाला; wali,waali=वाली; wale,waale=वाले; saath,sath=साथ; baad=बाद
pehle,pehli,pehla=पहले; accha,acha,achha,achcha,acchha,achchha=अच्छा; acche,achhe,achche=अच्छे; acchi,achi,achhi,achchi=अच्छी
mast=मस्त; badhiya,badiya,badhia,badia=बढ़िया; zabardast,jabardast,zabardust=ज़बरदस्त; shandar,shaandar=शानदार
kamaal,kamal=कमाल; maza,mazaa,maja,majaa,mazza=मज़ा; mazedaar,mazedar,majedar=मज़ेदार; jhakaas,jhakas=झक्कास
bawaal,bawal=बवाल; sahi,sai=सही; galat=गलत; bekar,bekaar=बेकार; pagal,paagal=पागल; theek,thik,thk=ठीक
pyaar,pyar=प्यार; dil=दिल; khush=खुश; khushi=खुशी; shukriya,sukriya,shukria=शुक्रिया; dhanyavaad,dhanyawad,dhanyavad=धन्यवाद
namaste,namaskar=नमस्ते; jai=जय; hind=हिंद; bharat=भारत; desi=देसी; wah,waah,vah=वाह; arre,arey,arree=अरे; oye,oyee=ओए
tum=तुम; tu=तू; tera=तेरा; teri=तेरी; tere=तेरे; mera=मेरा; meri=मेरी; mere=मेरे; apna=अपना; apni=अपनी; apne=अपने
aap,ap=आप; aapka,apka=आपका; aapki,apki=आपकी; aapke,apke=आपके; aapko,apko=आपको; humara,hamara=हमारा; humari,hamari=हमारी
humare,hamare=हमारे; mujhe,muje,mujhko=मुझे; tujhe,tuje,tujhko=तुझे; tumhe,tumhein=तुम्हें; tumhara=तुम्हारा; tumhari=तुम्हारी
tumhare=तुम्हारे; yeh,ye=ये; woh,wo,vo,voh=वो; yahan,yaha=यहाँ; wahan,waha=वहाँ; iska=इसका; iski=इसकी; iske=इसके
uska=उसका; uski=उसकी; uske=उसके; unka=उनका; unki=उनकी; unke=उनके; mai,mae=मैं
kar=कर; karo,kro=करो; karna,krna=करना; karte,krte=करते; karta,krta=करता; karti=करती; kiya=किया; kiye=किए
karunga,krunga=करूँगा; karenge=करेंगे; karega=करेगा; raha,rha=रहा; rahi,rhi=रही; rahe,rhe=रहे; raho,rho=रहो; rehna=रहना
dekh=देख; dekho=देखो; dekha=देखा; dekhna=देखना; dekhte=देखते; dekhta=देखता; dekhenge=देखेंगे; khel=खेल; khelo=खेलो
khela=खेला; khelna=खेलना; khelte=खेलते; khelta=खेलता; khelunga=खेलूँगा; jeet=जीत; jeeto=जीतो; jeetna=जीतना; jeeta=जीता
haar=हार; haara=हारा; chalo=चलो; chal=चल; chala=चला; aaya,aya=आया; aayi,aai=आई; aaye,aye=आए; aao,aaoo=आओ; aa=आ
gaya,gya=गया; gayi,gyi=गई; gaye,gye=गए; jao=जाओ; jaa,ja=जा; jana,jaana=जाना; jayega,jaega,jaayega=जाएगा; jaenge,jayenge=जाएँगे
dena=देना; dunga,doonga=दूँगा; denge=देंगे; diya=दिया; lena=लेना; liya=लिया; lagta,lgta=लगता; lagti,lgti=लगती
lagte,lgte=लगते; laga,lga=लगा; lagi,lgi=लगी; chahiye,chaiye,chahie=चाहिए; samajh,samjh=समझ; samjha=समझा; samjho=समझो
bol=बोल; bolo=बोलो; bola=बोला; bolna=बोलना; suno=सुनो; suna=सुना; mila=मिला; milte=मिलते; milenge=मिलेंगे; milna=मिलना
shuru,suru=शुरू; khatam,khatm=ख़त्म; intezaar,intezar,intjar=इंतज़ार; gaana,gana=गाना; khana,khaana=खाना; paani,pani=पानी
chai=चाय; paisa=पैसा; paise=पैसे; rupaye,rupay,rupaiye=रुपये; ek=एक; teen=तीन; paanch,panch=पांच; sau=सौ; hazaar,hazar=हज़ार
lakh=लाख; bada=बड़ा; badi=बड़ी; bade=बड़े; chhota,chota=छोटा; chhoti,choti=छोटी; chhote,chote=छोटे; naya=नया; nayi=नई
purana=पुराना; ladka=लड़का; ladki=लड़की; ladke=लड़के; banda=बंदा; bande=बंदे; baccha,bacha=बच्चा; bacche,bache=बच्चे
bhagwan,bhagwaan=भगवान; haal,hal=हाल; baar=बार; ab=अब; itna=इतना; itni=इतनी; pura,poora=पूरा;
zindagi,jindagi=ज़िंदगी; duniya=दुनिया; mujhse,mujse=मुझसे; tumse=तुमसे; aana=आना; chahta=चाहता; chahti=चाहती; aise,aese=ऐसे; waise,vaise=वैसे; jaise=जैसे; aisa=ऐसा; waisa=वैसा; jaisa=जैसा
`;

/**
 * Hindi words that are also English words ("to", "me", "main"). They're only read as Hindi next to a
 * Hindi word, as in "tu to mast hai", and stay English in "welcome to the stream".
 */
const AMBIGUOUS_WORDS = `
to=तो; me=में; main=मैं; par=पर; ho=हो; hum=हम; log=लोग; sun=सुन; mile=मिले; are=अरे; or=और; ache=अच्छे; bus=बस; bas=बस
de=दे; beta=बेटा; do=दो; lo=लो; le=ले; jab=जब; tab=तब; din=दिन; char=चार; na=ना; h=है; hi=ही
`;

function parse(table: string): Map<string, string> {
  const words = new Map<string, string>();
  for (const entry of table.split(/[;\n]/)) {
    const [spellings, devanagari] = entry.split('=');
    if (!devanagari) continue;
    for (const spelling of spellings!.split(',')) {
      const word = spelling.trim();
      if (word && !words.has(word)) words.set(word, devanagari.trim());
    }
  }
  return words;
}

const HINDI = parse(HINDI_WORDS);
const AMBIGUOUS = parse(AMBIGUOUS_WORDS);
// "do" is an English verb far more often than "two" ("bhai do it"), and "hi" is Hindi only after a Hindi
// word ("aise hi") since it starts so many messages as a greeting ("Hi bhai!").
AMBIGUOUS.delete('do');
const AFTER_HINDI_ONLY = new Set(['hi']);

const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN_WORD = /[A-Za-z]+/g;

/** "bhaiii" is "bhai", "maaast" is "mast", "acchaaa" is "accha". */
function lookup(table: Map<string, string>, word: string): string | undefined {
  const lower = word.toLowerCase();
  return table.get(lower) ?? table.get(lower.replace(/(.)\1{2,}/g, '$1$1')) ?? table.get(lower.replace(/(.)\1+/g, '$1'));
}

/**
 * The text for a Hindi voice when the message is Hindi or Hinglish; null when it's English, which an
 * English voice reads better.
 */
export function hindiSpeech(text: string): string | null {
  const words = text.match(LATIN_WORD) ?? [];
  const hindiHits = words.filter((w) => lookup(HINDI, w)).length;
  const isHindi = DEVANAGARI.test(text) || hindiHits >= 2 || (hindiHits >= 1 && hindiHits / words.length >= 0.3);
  if (!isHindi) return null;

  const isHindiWord = (w: string | undefined) => w !== undefined && lookup(HINDI, w) !== undefined;
  let i = -1;
  return text.replace(LATIN_WORD, (word) => {
    i += 1;
    const known = lookup(HINDI, word);
    if (known) return known;
    const maybe = lookup(AMBIGUOUS, word);
    const nextCounts = !AFTER_HINDI_ONLY.has(word.toLowerCase());
    if (maybe && (isHindiWord(words[i - 1]) || (nextCounts && isHindiWord(words[i + 1])))) return maybe;
    return word;
  });
}
