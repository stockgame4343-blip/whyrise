(async function(){
    'use strict';
    const $=id=>document.getElementById(id);
    const labels={threads:'Threads',instagram:'인스타',kakao:'카톡',toss:'토스',telegram:'텔레그램'};
    const limits={threads:500,instagram:2200,kakao:1000,toss:4000,telegram:4096};
    const states={prepared:'계정 연결 전 · 원고 준비',uploading:'전송 확인 필요',uploaded:'이미지 업로드됨',retryable:'다음 실행에서 재시도',manual_ready:'수동 게시용 준비',needs_connection:'계정 연결 필요',published:'게시 완료',uncertain:'전송 결과 확인 필요',creating:'전송 확인 필요',publishing:'전송 확인 필요',created:'이미지 처리 중',awaiting_image:'이미지 배포 대기',needs_api_version:'API 설정 필요'};
    const symbols={theme:'◉',market:'▥',calendar:'▦',leader:'♜'};
    const get=async url=>{const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);return r.json();};
    const WD=['일','월','화','수','목','금','토'];
    const dayLabel=v=>`${+v.slice(4,6)}월 ${+v.slice(6)}일 (${WD[new Date(Date.UTC(+v.slice(0,4),+v.slice(4,6)-1,+v.slice(6))).getUTCDay()]})`;
    // 날짜 이동 — ?date=YYYYMMDD (없으면 최신). 원고가 있는 날짜만 고를 수 있다.
    async function setupDates(){
        const latest=await get('/marketing/latest.json').catch(()=>null);
        const idx=await get('/marketing/dates.json').catch(()=>null);
        let dates=(idx&&Array.isArray(idx.dates)?idx.dates:[]).filter(v=>/^\d{8}$/.test(v));
        if(latest&&/^\d{8}$/.test(latest.date)&&!dates.includes(latest.date))dates.push(latest.date);
        dates=[...new Set(dates)].sort().reverse();
        const want=new URLSearchParams(location.search).get('date')||'';
        const date=dates.includes(want)?want:(latest&&latest.date)||dates[0]||'';
        const sel=$('dateSelect');sel.replaceChildren();
        dates.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=dayLabel(v)+(v===dates[0]?' · 최신':'');sel.append(o);});
        sel.value=date;
        const go=v=>{if(v&&v!==date)location.href=location.pathname+'?date='+v+location.hash;};
        const i=dates.indexOf(date);
        $('datePrev').disabled=i<0||i>=dates.length-1;$('dateNext').disabled=i<=0;
        $('datePrev').onclick=()=>go(dates[i+1]);$('dateNext').onclick=()=>go(dates[i-1]);
        sel.onchange=()=>go(sel.value);
        return date;
    }
    try {
        const date=await setupDates();
        if(!/^\d{8}$/.test(date))throw Error('Invalid date');
        const base='/marketing/'+date+'/';
        const d=await get(base+'digest.json');
        if(d.version!==2||d.date!==date||!d.stories?.length)throw Error('Visual digest unavailable');
        const manifest=await get(base+'assets.json');
        if(manifest.date!==d.date||manifest.content_hash!==d.content_hash)throw Error('Images updating');
        $('date').textContent=`${+d.date.slice(4,6)}월 ${+d.date.slice(6)}일 · 장 마감`;
        $('postDate').textContent=`${+d.date.slice(4,6)}월 ${+d.date.slice(6)}일`;
        let selected=d.default_story,channel='threads',imageIndex=0;
        const edits={};
        const story=()=>d.stories.find(s=>s.id===selected);
        const asset=id=>d.assets.find(a=>a.id===id);
        function imageUrl(a){if(!/^[a-z-]+\.jpg$/.test(a.file)||!manifest.assets[a.file])throw Error('Image unavailable');const file=manifest.assets[a.file].file;if(!/^[a-z-]+\.[a-f0-9]{12}\.jpg$/.test(file||''))throw Error('Invalid image');return base+file;}
        function syncCaption(){
            const text=$('copyText').value,n=Array.from(text).length;
            $('caption').textContent=text;$('count').textContent=n+' / '+limits[channel];
            $('copy').disabled=!text.trim()||n>limits[channel];
            $('count').style.color=n>limits[channel]?'#cf354d':'';
        }
        function drawImage(){
            const s=story(),a=asset(s.assets[imageIndex]);$('images').replaceChildren();
            const img=document.createElement('img');img.src=imageUrl(a);img.alt=a.alt;
            img.onerror=()=>{$('feedback').textContent='이미지를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.';};
            $('images').append(img);
            if(s.assets.length>1){const nav=document.createElement('div');nav.className='image-nav';for(const [label,delta] of [['이전 이미지',-1],['다음 이미지',1]]){const b=document.createElement('button');b.type='button';b.setAttribute('aria-label',label);b.textContent=delta<0?'‹':'›';b.onclick=()=>{imageIndex=(imageIndex+delta+s.assets.length)%s.assets.length;drawImage();};nav.append(b);}$('images').append(nav);}
            $('imageCount').textContent=`${imageIndex+1} / ${s.assets.length}장`;
            $('previewLabel').textContent=a.label;
            document.querySelectorAll('.image-choice').forEach((b,i)=>{b.classList.toggle('active',i===imageIndex);b.setAttribute('aria-pressed',String(i===imageIndex));});
        }
        function choose(){
            const s=story();imageIndex=0;
            $('copyText').value=edits[selected+':'+channel]??(s.posts[channel]?.text||'');
            $('channelHint').textContent=channel==='toss'?'시황·관련 종목 게시판용':channel==='instagram'?'이미지 먼저 · 짧은 캡션':'이미지와 함께 올려주세요';
            document.querySelectorAll('.story').forEach(b=>{b.classList.toggle('active',b.dataset.story===selected);b.setAttribute('aria-pressed',String(b.dataset.story===selected));});
            document.querySelectorAll('.channel').forEach(b=>{b.classList.toggle('active',b.dataset.channel===channel);b.setAttribute('aria-pressed',String(b.dataset.channel===channel));});
            $('downloads').replaceChildren();$('imagePicker').replaceChildren();
            s.assets.forEach((id,i)=>{const a=asset(id),url=imageUrl(a);const link=document.createElement('a');link.className='download';link.href=url;link.download=`orgo-${d.date}-${a.file}`;const label=document.createElement('span');label.textContent=a.label;const arrow=document.createElement('span');arrow.textContent='↓';link.append(label,arrow);$('downloads').append(link);const b=document.createElement('button');b.className='image-choice';b.type='button';b.setAttribute('aria-label',a.label+' 미리보기');const thumb=document.createElement('img');thumb.src=url;thumb.alt='';b.append(thumb);b.onclick=()=>{imageIndex=i;drawImage();};$('imagePicker').append(b);});
            $('imagePicker').hidden=s.assets.length<2;
            $('facts').replaceChildren();s.facts.forEach(f=>{const li=document.createElement('li');li.textContent=f;$('facts').append(li);});
            $('source').href=asset(s.assets[0]).source;
            $('schedule').textContent='자동 발행 주제: '+d.stories.find(s=>s.id===d.default_story).label+' · 평일 장 마감 후';
            $('feedback').textContent='';syncCaption();drawImage();
        }
        d.stories.forEach(s=>{const b=document.createElement('button');b.type='button';b.className='story';b.dataset.story=s.id;const icon=document.createElement('span');icon.className='symbol';icon.textContent=symbols[s.id]||'◉';icon.setAttribute('aria-hidden','true');const div=document.createElement('div'),strong=document.createElement('b'),small=document.createElement('small');strong.textContent=s.label;small.textContent=s.note;div.append(strong,small);b.append(icon,div);b.onclick=()=>{selected=s.id;choose();};$('stories').append(b);});
        Object.entries(labels).filter(([key])=>key==='telegram'||d.posts?.[key]).forEach(([key,label])=>{const b=document.createElement('button');b.type='button';b.className='channel';b.dataset.channel=key;b.textContent=label;b.onclick=()=>{channel=key;choose();};$('channels').append(b);});
        $('copyText').oninput=()=>{edits[selected+':'+channel]=$('copyText').value;syncCaption();};
        $('reset').onclick=()=>{delete edits[selected+':'+channel];$('copyText').value=story().posts[channel]?.text||'';syncCaption();};
        $('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('copyText').value);$('feedback').textContent='복사했어요. 이미지와 함께 올려주세요.';}catch(e){$('copyText').focus();$('copyText').select();$('feedback').textContent='본문을 선택했습니다. 직접 복사해 주세요.';}};
        choose();$('studio').setAttribute('aria-busy','false');
        loadBlog(base, d).catch(()=>{$('blogStatus').textContent='원고 없음';});
        const status=await get('/marketing/status.json').catch(()=>null);
        Object.entries(labels).forEach(([key,label])=>{const row=document.createElement('div');row.className='status-row';const name=document.createElement('span'),value=document.createElement('span');name.textContent=label;value.textContent=key==='telegram'?'기존 텔레그램 봇 별도 운영':status?.date===d.date?(states[status.channels[key]?.status]||'상태 미확인'):'발행 상태 미확인';row.append(name,value);$('status').append(row);});
        async function loadBlog(base, d){
            const b=await get(base+'naver-blog.json');
            if(b.date!==d.date||!b.title||!b.html)throw Error('blog');
            $('blogTitle').textContent=b.title;
            $('blogTags').textContent=(b.tags||[]).map(t=>'#'+t).join(' ');
            $('blogFrame').src=base+'naver-blog.html';$('blogOpen').href=base+'naver-blog.html';
            const st=await get('/marketing/status.json').catch(()=>null);
            const nb=st?.date===d.date?st.channels?.naver_blog:null;
            $('blogStatus').textContent=nb?.status==='published'?'자동 발행 완료':nb?.status?('상태: '+nb.status):`${+d.date.slice(4,6)}월 ${+d.date.slice(6)}일 원고`;
            const say=t=>{$('blogFeedback').textContent=t;};
            const copyText=async(t,label)=>{try{await navigator.clipboard.writeText(t);say(label+' 복사했어요.');}catch(e){say('복사 권한이 없어 직접 선택해 주세요.');}};
            $('blogCopyTitle').onclick=()=>copyText(b.title,'제목을');
            $('blogCopyTags').onclick=()=>copyText((b.tags||[]).join(','),'태그를');
            $('blogCopyHtml').onclick=async()=>{
                try{
                    // 서식(굵게·목록)과 이미지 주소를 함께 — 네이버 블로그 에디터에 그대로 붙여넣기
                    await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([b.html],{type:'text/html'}),'text/plain':new Blob([b.text||''],{type:'text/plain'})})]);
                    say('본문을 서식 포함으로 복사했어요. 블로그 글쓰기 본문에 붙여넣으세요.');
                }catch(e){await copyText(b.text||'','본문(글자만)을');}
            };
            $('blog').setAttribute('aria-busy','false');
        }
    }catch(e){$('error').hidden=false;$('error').textContent='이 날짜의 이미지를 준비하고 있습니다. 잠시 후 다시 확인하거나 다른 날짜를 골라 주세요.';$('studio').hidden=true;$('date').textContent='준비 중';$('blogStatus').textContent='원고 없음';}
})();
