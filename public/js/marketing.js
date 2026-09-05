(async function(){
    'use strict';
    const $=id=>document.getElementById(id);
    const labels={threads:'Threads',instagram:'인스타그램',kakao:'카카오톡',toss:'토스 커뮤니티',telegram:'텔레그램'};
    const states={prepared:'원고 준비 완료',manual_ready:'원고 준비 · 계정/발송 경로 연결 필요',needs_connection:'계정 연결 필요',published:'게시 완료',uncertain:'전송 결과 확인 필요',creating:'전송 확인 필요',publishing:'전송 확인 필요',created:'이미지 처리 중',awaiting_image:'이미지 배포 대기',needs_api_version:'API 설정 필요'};
    try {
        const latest=await fetch('/marketing/latest.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error();return r.json();});
        if(!/^\d{8}$/.test(latest.date))throw Error();
        const base='/marketing/'+latest.date+'/';
        const d=await fetch(base+'digest.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error();return r.json();});
        $('meta').textContent=`${d.date} 장 마감 · ${d.overview} · 이유 확인 ${d.coverage.supported} · 관련 보도 ${d.coverage.related_news || 0} · 확인 중 ${d.coverage.unresolved}종목`;
        let selected='threads';
        function choose(channel){selected=channel;$('text').textContent=d.posts[channel].text;$('download').href=base+channel+'.txt';$('state').textContent=channel==='toss'?'종목 게시판용 · 운영자 작성 사실을 본문에 표시했습니다.':'원문과 기준 날짜를 확인한 뒤 게시하세요.';document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('active',b.dataset.channel===channel));}
        Object.entries(labels).forEach(([channel,label])=>{const b=document.createElement('button');b.textContent=label;b.dataset.channel=channel;b.onclick=()=>choose(channel);$('tabs').append(b);});choose(selected);
        $('copy').onclick=async()=>{try{await navigator.clipboard.writeText(d.posts[selected].text);$('feedback').textContent='본문을 복사했습니다.';}catch(e){$('feedback').textContent='복사 권한이 없습니다. 본문을 선택해 복사하거나 다운로드하세요.';}};
        $('card').src=base+'card.jpg';$('imageDownload').href=base+'card.jpg';
        $('card').onerror=()=>{$('card').hidden=true;$('imageDownload').textContent='카드 HTML 보기';$('imageDownload').href=base+'card.html';};
        d.movers.forEach(r=>{const div=document.createElement('div');div.className='item';const a=document.createElement('a');a.href='/stock/'+encodeURIComponent(r.ticker);a.textContent=r.name+' '+(r.rate>=0?'+':'')+r.rate+'%';div.append(a);const p=document.createElement('p');p.textContent=r.text;div.append(p);r.news.forEach(n=>{try{if(new URL(n.link).protocol!=='https:')return;}catch(e){return;}const a=document.createElement('a');a.href=n.link;a.target='_blank';a.rel='noopener noreferrer';a.textContent=n.date+' · '+n.title;div.append(a,document.createElement('br'));});$('evidence').append(div);});
        const status=await fetch('/marketing/status.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null);
        $('channels').textContent=Object.entries(labels).filter(([k])=>k!=='telegram').map(([k,v])=>v+': '+(status&&status.date===d.date?states[status.channels[k]?.status]||'상태 확인 필요':'원고 준비 · 발행 상태 미확인')).join('\n');$('channels').style.whiteSpace='pre-line';
    }catch(e){$('meta').textContent='아직 발행된 시황이 없습니다. 다음 장 마감 데이터 생성 후 확인해 주세요.';}
})();
