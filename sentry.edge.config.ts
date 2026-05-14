import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? "https://eaf053ec6bfaa474022c4a6696b64e26@o4511386730430464.ingest.us.sentry.io/4511386731806720",

  sendDefaultPii: true,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  enableLogs: true,
});
