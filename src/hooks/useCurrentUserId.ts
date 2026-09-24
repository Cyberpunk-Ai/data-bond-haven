import { useEffect, useState } from "react";

import { currentUserId, subscribeProfiles } from "@/lib/profile-service";

/** Re-renders when the signed-in profile becomes known (or changes). */
export function useCurrentUserId(): string {
  const [id, setId] = useState(currentUserId);
  useEffect(() => {
    const sync = () => setId(currentUserId);
    sync();
    const off = subscribeProfiles(sync);
    return () => {
      off();
    };
  }, []);
  return id;
}
