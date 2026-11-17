// 홈 화면 앱(PWA) 파일: 서비스워커 + 매니페스트
//
// 서비스워커: 브라우저가 우리 사이트 대신 백그라운드에서 돌려주는 스크립트.
//   앱을 닫아도 푸시가 오면 깨어나서 알림을 띄우고, 알림을 누르면 매치 페이지를 엶.
//   사이트 맨 위 경로(/sw.js)에서 내려줘야 사이트 전체를 맡을 수 있음.
// 매니페스트: "홈 화면에 추가"했을 때 앱 이름·아이콘·전체 화면 여부를 알려주는 파일.

export const SW_JS = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// 푸시 도착 → 알림 표시 (iOS는 푸시마다 반드시 알림을 띄워야 함)
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "플랩레이더", {
    body: d.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: d.tag || undefined,
    data: { url: d.url || "/" },
  }));
});

// 알림 누르기 → 매치 페이지 열기
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.openWindow(url));
});
`;

export const MANIFEST = JSON.stringify({
  name: "플랩레이더",
  short_name: "플랩레이더",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#ffffff",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
});
