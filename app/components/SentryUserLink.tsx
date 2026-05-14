"use client";

import { useUser } from "@clerk/nextjs";
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export function SentryUserLink() {
  const { user, isLoaded, isSignedIn } = useUser();

  useEffect(() => {
    if (isLoaded && isSignedIn && user) {
      Sentry.setUser({
        id: user.id,
        email: user.primaryEmailAddress?.emailAddress,
        username: user.username || undefined,
      });
    } else if (isLoaded && !isSignedIn) {
      Sentry.setUser(null);
    }
  }, [isLoaded, isSignedIn, user]);

  return null;
}
