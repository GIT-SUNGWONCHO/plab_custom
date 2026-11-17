// 플랩레이더 ntfy 중계 (구글 Apps Script 웹앱)
// Cloudflare 공용 IP 대신 구글 서버에서 ntfy.sh로 보내기 위한 중계.
// 스크립트 속성(프로젝트 설정 → 스크립트 속성)에 넣을 값:
//   RELAY_SECRET : Cloudflare 워커의 NTFY_RELAY_SECRET과 같은 아무 긴 랜덤 문자열
//   NTFY_TOKEN   : ntfy.sh 액세스 토큰 (tk_...)
// 받는 요청: POST { secret, payload: { topic, title, message, tags, click, priority } }
// 돌려주는 값: { status, body } (ntfy 응답 그대로)

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ error: 'bad json' }); }
  if (!req || req.secret !== props.getProperty('RELAY_SECRET')) return out_({ error: 'forbidden' });
  var p = req.payload || {};
  if (typeof p.topic !== 'string' || !/^[A-Za-z0-9_-]{12,64}$/.test(p.topic)) return out_({ error: 'bad topic' });
  var headers = {};
  var token = props.getProperty('NTFY_TOKEN');
  if (token) headers.Authorization = 'Bearer ' + token;
  var res = UrlFetchApp.fetch('https://ntfy.sh', {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify({
      topic: p.topic, title: p.title, message: p.message, tags: p.tags, click: p.click, priority: p.priority,
    }),
    muteHttpExceptions: true,
  });
  return out_({ status: res.getResponseCode(), body: res.getContentText().slice(0, 500) });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
