#!/usr/bin/env python3
"""Pipeline de produção do Radar Diário: RSS -> Gemini -> Wikimedia Commons -> Piper."""
import argparse, email.utils, html, json, os, re, sys, time, wave, xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from io import BytesIO
from urllib.parse import urljoin
import requests
from bs4 import BeautifulSoup
from PIL import Image, ImageDraw, ImageFont

UA="OSeuRadar-RadarDiario/1.0"
S=requests.Session(); S.headers.update({"User-Agent":UA})
FEEDS=[
("G1 Tecnologia","https://g1.globo.com/rss/g1/tecnologia/"),
("Tecnoblog","https://tecnoblog.net/feed/"),
("Canaltech","https://canaltech.com.br/rss/"),
("The Verge","https://www.theverge.com/rss/index.xml"),
("TechCrunch IA","https://techcrunch.com/category/artificial-intelligence/feed/"),
("Ars Technica","https://feeds.arstechnica.com/arstechnica/technology-lab"),
("MIT Technology Review IA","https://www.technologyreview.com/topic/artificial-intelligence/feed"),
]
TOPIC=re.compile(r"\b(ia|intelig[eê]ncia artificial|machine learning|software|hardware|tecnologia|ciberseguran[cç]a|seguran[cç]a digital|computador|data cent(er|re)|nuvem|cloud|semicondutor|chip|programa[cç][aã]o|openai|google|microsoft|nvidia|meta|apple|amazon|rob[oô]|algoritmo|modelo de linguagem|llm|deepfake|phishing|ransomware|vulnerabilidade|linux|android|ios|internet|telecom|5g|6g)\b",re.I)

def get(url,**kw):
 r=S.get(url,timeout=25,**kw); r.raise_for_status(); return r

def dateval(v):
 if not v:return None
 try:d=email.utils.parsedate_to_datetime(v)
 except Exception:
  try:d=datetime.fromisoformat(v.replace("Z","+00:00"))
  except Exception:return None
 if d.tzinfo is None:d=d.replace(tzinfo=timezone.utc)
 return d.astimezone(timezone.utc)

def node_text(n,names):
 for name in names:
  x=n.find(name)
  if x is not None:
   v="".join(x.itertext()).strip()
   if v:return v
 return ""

def feeds():
 found=[]
 for home in ("https://oseuradar.com.br/","https://www.oseuradar.com.br/"):
  try:
   soup=BeautifulSoup(get(home).text,"html.parser")
   for x in soup.find_all("link",rel="alternate"):
    if "rss" in (x.get("type") or "").lower() or "atom" in (x.get("type") or "").lower():
     if x.get("href"):found.append(("O Seu Radar",urljoin(home,x["href"])))
  except Exception as e:print("[site RSS]",e,file=sys.stderr)
 for p in ("/feed/","/feed.xml","/rss.xml","/rss/"):found.append(("O Seu Radar","https://oseuradar.com.br"+p))
 return found+FEEDS

def read_feed(source,url,cutoff):
 out=[]
 try:
  payload=get(url).content
  try:root=ET.fromstring(payload)
  except ET.ParseError:
   text=payload.decode("utf-8",errors="replace")
   text=re.sub(r"&(?!#\d+;|#x[0-9a-fA-F]+;|[A-Za-z][\w.-]*;)","&amp;",text)
   text=re.sub(r"[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\U00010000-\U0010FFFF]","",text)
   text=text.lstrip()
   if text.startswith("<?xml") and "?>" in text:text=text.split("?>",1)[1]
   root=ET.fromstring(text.encode("utf-8"))
   print(f"[feed] {source}: XML recuperado após normalização de caracteres inválidos.",file=sys.stderr)
  for item in root.findall(".//item"):
   title=node_text(item,["title"]); link=node_text(item,["link"])
   desc=node_text(item,["description","{http://purl.org/rss/1.0/modules/content/}encoded"])
   dt=dateval(node_text(item,["pubDate","{http://purl.org/dc/elements/1.1/}date"]))
   if title and link and dt and dt>=cutoff:
    image=""
    for x in item.iter():
     if x.tag.endswith(("}content","}thumbnail","}enclosure")):
      image=x.attrib.get("url","")
      if image:break
    out.append({"title":BeautifulSoup(html.unescape(title),"html.parser").get_text(" ",strip=True),"url":link.strip(),"summary":BeautifulSoup(desc,"html.parser").get_text(" ",strip=True)[:1800],"published":dt.isoformat(),"source":source,"feed_image":image})
  if not out:
   ns={"a":"http://www.w3.org/2005/Atom"}
   for item in root.findall(".//a:entry",ns):
    title=node_text(item,["{http://www.w3.org/2005/Atom}title"])
    link=item.find("a:link",ns); url2=link.attrib.get("href","") if link is not None else ""
    desc=node_text(item,["{http://www.w3.org/2005/Atom}summary","{http://www.w3.org/2005/Atom}content"])
    dt=dateval(node_text(item,["{http://www.w3.org/2005/Atom}published","{http://www.w3.org/2005/Atom}updated"]))
    if title and url2 and dt and dt>=cutoff:out.append({"title":title,"url":url2,"summary":BeautifulSoup(desc,"html.parser").get_text(" ",strip=True)[:1800],"published":dt.isoformat(),"source":source,"feed_image":""})
 except ET.ParseError as e:print(f"[feed] {source}: XML inválido nesta URL; fonte ignorada ({e})",file=sys.stderr)
 except Exception as e:print(f"[feed] {source}: falha ao ler feed; fonte ignorada ({e})",file=sys.stderr)
 return out

def article_body(url):
 try:
  soup=BeautifulSoup(get(url).text,"html.parser")
  for x in soup(["script","style","nav","footer","header","aside","form","noscript"]):x.decompose()
  main=soup.find("article") or soup.find("main") or soup.body or soup
  paras=[x.get_text(" ",strip=True) for x in main.find_all(["p","h2","h3"])]
  return re.sub(r"\s+"," "," ".join(p for p in paras if len(p)>45))[:6500]
 except Exception as e:print("[article]",url,e,file=sys.stderr);return ""

def collect(hours,limit):
 cutoff=datetime.now(timezone.utc)-timedelta(hours=hours); seen=set(); out=[]
 for source,url in feeds():
  for item in read_feed(source,url,cutoff):
   key=item["url"].split("#")[0].rstrip("/")
   if key in seen or not TOPIC.search(item["title"]+" "+item["summary"]):continue
   seen.add(key); item["body"]=article_body(item["url"])
   if len(item["summary"]+" "+item["body"])<150:continue
   out.append(item)
   if len(out)>=limit:break
  if len(out)>=limit:break
 if len(out)<6:raise RuntimeError(f"Apenas {len(out)} notícias recentes elegíveis encontradas; são necessárias pelo menos 6.")
 return out

def gemini(items,short=False):
 key=os.getenv("GEMINI_API_KEY")
 if not key:raise RuntimeError("Configure GEMINI_API_KEY nos Secrets do GitHub.")
 model=os.getenv("GEMINI_MODEL","gemini-3.6-flash")
 candidates=[{k:x[k] for k in ("title","url","published","source","summary","body")} for x in items]
 prompt = ("""Você é editor-chefe do canal O Seu Radar no YouTube Shorts, dedicado EXCLUSIVAMENTE a Tecnologia da Informação e Inteligência Artificial. Escolha UMA notícia recente, relevante e bem sustentada entre as pautas fornecidas. Use apenas os fatos das fontes; não invente dados, datas, citações ou impactos. Escreva em português brasileiro natural, com ritmo de telejornal.
Crie um roteiro para um YouTube Short vertical com duração máxima de 60 segundos: a narração principal deve ter entre 95 e 115 palavras, adequada a aproximadamente 45–55 segundos de fala. Uma abertura de no máximo uma frase curta e um encerramento muito breve são opcionais; priorize a notícia. Inclua manchete curta, contexto essencial, o que aconteceu e por que importa. Evite saudações longas, listas, repetição e enchimento.
Retorne APENAS JSON válido: {"opening":"","stories":[{"source_url":"URL exata de uma pauta fornecida","source_name":"fonte fornecida","category":"Tecnologia da Informação ou Inteligência Artificial","headline":"manchete curta","narration":"locução original de 95 a 115 palavras","image_query":"descrição visual curta em inglês"}],"closing":"","editorial_notes":["..."]}. Inclua exatamente UMA matéria. source_url precisa ser uma URL exata recebida.""") if short else ("""Você é editor-chefe do telejornal brasileiro O Seu Radar — Radar Diário, dedicado EXCLUSIVAMENTE a Tecnologia da Informação e Inteligência Artificial. Use apenas as notícias fornecidas. Selecione 6 a 8 pautas recentes, distintas e relevantes. Não invente fatos, datas, números, citações ou fontes. Diferencie fatos de análise. Escreva em português brasileiro natural.
Crie edição de 12 a 15 minutos, com alvo de 1.700–1.850 palavras faladas (faixa aceitável de 1.550–2.050): abertura curta, 6–8 matérias de aproximadamente 230–270 palavras cada, transições naturais e encerramento. Desenvolva o contexto, explique impactos e limitações; contexto brasileiro somente quando sustentado pelas fontes. Não copie as matérias e não use repetição artificial para atingir a extensão.
Retorne APENAS JSON válido: {"opening":"...","stories":[{"source_url":"URL exata de uma pauta fornecida","source_name":"fonte fornecida","category":"Tecnologia da Informação ou Inteligência Artificial","headline":"manchete curta","narration":"locução original","image_query":"descrição visual curta em inglês"}],"closing":"...","editorial_notes":["..."]}. source_url precisa ser uma URL exata recebida. Não repita pautas.""")
 endpoint=f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
 def request_script(instruction):
  r=S.post(endpoint,params={"key":key},json={"contents":[{"role":"user","parts":[{"text":instruction+"\n\nPAUTAS:\n"+json.dumps(candidates,ensure_ascii=False)}]}],"generationConfig":{"temperature":0.25,"responseMimeType":"application/json","maxOutputTokens":16000}},timeout=180)
  if r.status_code==429:raise RuntimeError("Gemini atingiu a cota gratuita (HTTP 429); aguarde a renovação e tente novamente.")
  r.raise_for_status()
  try:raw=r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
  except (KeyError,IndexError,TypeError) as e:raise RuntimeError("Gemini não retornou um roteiro completo. Consulte os detalhes da execução.") from e
  raw=re.sub(r"^\x60{3}(?:json)?\s*|\s*\x60{3}$","",raw)
  return json.loads(raw)
 byurl={x["url"]:x for x in items}
 def validate(script):
  if isinstance(script,list):
   if len(script)==1 and isinstance(script[0],dict):
    script=script[0]
   else:
    raise RuntimeError("Gemini retornou uma lista na raiz do JSON; era esperado um objeto com opening, stories e closing.")
  if not isinstance(script,dict):
   raise RuntimeError(f"Gemini retornou {type(script).__name__} na raiz do JSON; era esperado um objeto.")
  raw_stories=script.get("stories",[])
  if not isinstance(raw_stories,list):
   raise RuntimeError("Formato inválido no roteiro: o campo stories precisa ser uma lista.")
  normalized_stories=[]
  for index,st in enumerate(raw_stories,1):
   if isinstance(st,dict):
    normalized_stories.append(st)
   elif isinstance(st,list) and all(isinstance(item,dict) for item in st):
    print(f"[Gemini] Matéria {index}: lista aninhada de objetos detectada; itens expandidos.")
    normalized_stories.extend(st)
   else:
    raise RuntimeError(f"Formato inválido na matéria {index}: esperado objeto JSON, recebido {type(st).__name__}.")
  script["stories"]=normalized_stories
  used=set(); stories=[]
  for index,st in enumerate(script["stories"],1):
   url=st.get("source_url",""); src=byurl.get(url); narration=str(st.get("narration","")).strip(); words=len(narration.split())
   if not src or url in used or words<(90 if short else 130):continue
   used.add(url); st.update({"source_url":url,"source_name":src["source"],"article_title":src["title"],"published":src["published"],"headline":str(st.get("headline") or src["title"])[:150],"word_count":words})
   if st.get("category") not in ("Tecnologia da Informação","Inteligência Artificial"):st["category"]="Tecnologia da Informação"
   stories.append(st)
  if (len(stories)!=1 if short else not 6<=len(stories)<=8):raise RuntimeError(f"Gemini retornou {len(stories)} matérias válidas; necessário exatamente 1 para Shorts." if short else f"Gemini retornou {len(stories)} matérias válidas; necessário de 6 a 8.")
  script["stories"]=stories
  words=len(str(script.get("opening","")).split())+len(str(script.get("closing","")).split())+sum(x["word_count"] for x in stories)
  return words
 script=request_script(prompt)
 words=validate(script)
 if ((not 95<=words<=125) if short else (not 1550<=words<=2050)):
  print(f"[Gemini] Roteiro inicial com {words} palavras; solicitando uma revisão de extensão sem acrescentar fatos...")
  revision_prompt=("Revise o JSON para que a narração tenha entre 95 e 115 palavras, mantendo exatamente uma matéria, a mesma URL, fonte e fatos. Não invente dados nem acrescente enchimento. Retorne apenas JSON.\nROTEIRO ANTERIOR:\n" if short else """Revise o roteiro JSON abaixo para que a locução completa fique entre 1.650 e 1.900 palavras. A versão anterior ficou fora da faixa. Preserve exatamente as 6–8 pautas, URLs, fontes e fatos já sustentados pelo material de referência. Amplie ou reduza com contexto, explicações, consequências e transições úteis, sem inventar dados, exemplos apresentados como fatos, citações ou acontecimentos. Não repita ideias nem acrescente enchimento. Cada matéria deve ter aproximadamente 230–270 palavras. Mantenha o formato JSON e os mesmos campos. Retorne APENAS o JSON revisado.\nROTEIRO ANTERIOR:\n""")+json.dumps(script,ensure_ascii=False)
  script=request_script(revision_prompt)
  words=validate(script)
 if ((not 95<=words<=125) if short else (not 1550<=words<=2050)):raise RuntimeError(f"Após uma revisão, o roteiro ficou com {words} palavras, fora da faixa do formato solicitado; nenhuma publicação foi feita.")
 script.update({"program_title":"O Seu Radar — Radar Diário","edition_date":datetime.now(timezone.utc).strftime("%Y-%m-%d"),"stories":script["stories"],"estimated_minutes":round(words/135,1)})
 print(f"[Gemini] Roteiro validado: {words} palavras, estimativa de {script['estimated_minutes']} minutos.")
 return script

def commons(query,dest):
 params={"action":"query","generator":"search","gsrsearch":query+" filetype:bitmap","gsrnamespace":6,"gsrlimit":8,"prop":"imageinfo","iiprop":"url|extmetadata","iiurlwidth":1600,"format":"json"}
 try:
  pages=get("https://commons.wikimedia.org/w/api.php",params=params).json().get("query",{}).get("pages",{})
  for p in pages.values():
   info=(p.get("imageinfo") or [{}])[0]; meta=info.get("extmetadata",{})
   lic=BeautifulSoup(meta.get("LicenseShortName",{}).get("value",""),"html.parser").get_text(" ",strip=True)
   license_text=lic.lower()
   if not ("cc0" in license_text or "public domain" in license_text or ("cc by" in license_text and "sa" not in license_text)):continue
   url=info.get("thumburl") or info.get("url")
   if not url:continue
   data=get(url).content
   if len(data)<4000:continue
   dest.write_bytes(data)
   return {"file":dest.name,"title":p.get("title",""),"source":"Wikimedia Commons","license":lic,"license_url":BeautifulSoup(meta.get("LicenseUrl",{}).get("value",""),"html.parser").get_text(" ",strip=True),"artist":BeautifulSoup(meta.get("Artist",{}).get("value",""),"html.parser").get_text(" ",strip=True)[:250],"credit_url":info.get("descriptionurl",""),"changes":"Convertida para JPEG; sem edição do conteúdo visual."}
 except Exception as e:print("[commons]",e,file=sys.stderr)
 return None

def placeholder(dest,title,index):
 im=Image.new("RGB",(1600,900),(12,28,42)); d=ImageDraw.Draw(im)
 f=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",58); sm=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",28)
 d.rectangle((0,0,1600,18),fill=(0,170,190)); d.text((90,100),"O SEU RADAR  /  RADAR DIÁRIO",font=sm,fill=(80,210,220))
 lines=[]; line=""
 for word in title.split():
  test=(line+" "+word).strip()
  if d.textbbox((0,0),test,font=f)[2]>1400 and line:lines.append(line);line=word
  else:line=test
 if line:lines.append(line)
 y=330-len(lines)*40
 for line in lines[:5]:d.text((90,y),line,font=f,fill="white");y+=82
 d.text((90,790),f"IMAGEM ILUSTRATIVA • PAUTA {index:02d}",font=sm,fill=(160,185,198));im.save(dest,quality=92)

def chunks(text,limit=1250):
 parts=re.split(r"(?<=[.!?])\s+",re.sub(r"\s+"," ",text.strip())); out=[]; cur=""
 for p in parts:
  while len(p)>limit:
   cut=p.rfind(" ",0,limit);cut=cut if cut>0 else limit
   if cur:out.append(cur);cur=""
   out.append(p[:cut]);p=p[cut:].strip()
  test=(cur+" "+p).strip()
  if len(test)>limit and cur:out.append(cur);cur=p
  else:cur=test
 if cur:out.append(cur)
 return out

def piper(script,out,short=False):
 key=os.getenv("PIPER_API_KEY")
 if not key:raise RuntimeError("Configure PIPER_API_KEY nos Secrets do GitHub.")
 endpoint=os.getenv("PIPER_API_URL","https://radar-ia-1.onrender.com/api/tts")
 text="\n\n".join([script.get("opening","")]+[x["headline"]+". "+x["narration"] for x in script["stories"]]+[script.get("closing","")])
 parts=chunks(text,limit=900 if short else 1250); files=[]
 for i,part in enumerate(parts,1):
  r=S.post(endpoint,headers={"Authorization":"Bearer "+key,"Content-Type":"application/json"},json={"text":part},timeout=180)
  if r.status_code==429:raise RuntimeError("Piper TTS retornou HTTP 429; aguarde e tente novamente.")
  r.raise_for_status(); path=out.parent/f"_tts_{i:03d}.wav";path.write_bytes(r.content);files.append(path);print(f"[Piper] trecho {i}/{len(parts)}");time.sleep(.25)
 with wave.open(str(files[0]),"rb") as first:params=first.getparams();frames=[first.readframes(first.getnframes())]
 for path in files[1:]:
  with wave.open(str(path),"rb") as w:
   if w.getparams()[:3]!=params[:3] or w.getparams()[4:]!=params[4:]:raise RuntimeError("Piper retornou arquivos WAV incompatíveis.")
   frames.append(w.readframes(w.getnframes()))
 with wave.open(str(out),"wb") as w:
  w.setparams(params)
  for frame in frames:w.writeframes(frame)
 for path in files:path.unlink(missing_ok=True)
 return len(parts),len(text)

def main():
 ap=argparse.ArgumentParser();ap.add_argument("--format",choices=("daily","shorts"),default="daily");ap.add_argument("--output-dir",default="output/edition");ap.add_argument("--lookback-hours",type=int,default=36);ap.add_argument("--max-articles",type=int,default=40);a=ap.parse_args()
 out=Path(a.output_dir);imgs=out/"images";imgs.mkdir(parents=True,exist_ok=True)
 print("[1/4] Coletando RSS do O Seu Radar e fontes externas de TI/IA...")
 items=collect(a.lookback_hours,a.max_articles);print(f"{len(items)} notícias candidatas")
 print("[2/4] Gemini está criando roteiro original...")
 script=gemini(items,short=a.format=="shorts")
 (out/"roteiro.json").write_text(json.dumps(script,ensure_ascii=False,indent=2),encoding="utf-8")
 full=script.get("opening","")+"\n\n"+"\n\n".join(s["headline"]+"\n"+s["narration"]+"\nFonte: "+s["source_name"]+" — "+s["source_url"] for s in script["stories"])+"\n\n"+script.get("closing","")
 (out/"roteiro.txt").write_text(full,encoding="utf-8")
 print("[3/4] Buscando imagens com licenças compatíveis no Wikimedia Commons...")
 credits=[]
 for i,st in enumerate(script["stories"],1):
  dest=imgs/f"{i:02d}.jpg";credit=commons(st.get("image_query") or st["headline"],dest)
  if not credit:placeholder(dest,st["headline"],i);credit={"file":dest.name,"source":"Arte ilustrativa original do Radar Diário","license":"Não é fotografia documental."}
  credits.append({**credit,"story":st["headline"],"article_source":st["source_url"]})
 (out/"creditos-imagens.json").write_text(json.dumps(credits,ensure_ascii=False,indent=2),encoding="utf-8")
 print("[4/4] Gerando a narração com o Piper TTS existente...")
 count,chars=piper(script,out/"audio.wav",short=a.format=="shorts")
 manifest={"title":"O Seu Radar — YouTube Shorts" if a.format=="shorts" else "O Seu Radar — Radar Diário","edition_date":script["edition_date"],"headline":script["stories"][0]["headline"],"stories":len(script["stories"]),"estimated_minutes":script["estimated_minutes"],"format":a.format,"tts_chunks":count,"characters_narrated":chars,"sources":[{"title":s["article_title"],"publisher":s["source_name"],"url":s["source_url"]} for s in script["stories"]],"image_credits":"creditos-imagens.json","approval_required":True,"youtube_published":False}
 (out/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8");print(json.dumps(manifest,ensure_ascii=False,indent=2))

if __name__=="__main__":
 try:main()
 except Exception as e:print("ERRO NA PRODUÇÃO:",e,file=sys.stderr);sys.exit(1)
