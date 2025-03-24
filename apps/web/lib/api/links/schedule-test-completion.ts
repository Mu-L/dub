import { qstash } from "@/lib/cron";
import { APP_DOMAIN_WITH_NGROK } from "@dub/utils";
import { ExpandedLink } from "./utils";

export async function scheduleTestCompletion(link: ExpandedLink) {
  const completionUrl = `${APP_DOMAIN_WITH_NGROK}/api/cron/links/${link.id}/complete-tests`;

  // Remove any previously scheduled completion jobs
  try {
    const deleteResponse = await fetch(
      "https://qstash.upstash.io/v2/messages",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: completionUrl,
        }),
      },
    );
    if (!deleteResponse.ok)
      throw new Error(
        `Fetch failed: ${deleteResponse.status} ${deleteResponse.statusText}`,
      );
  } catch (e) {
    console.error(
      "scheduleTestCompletion: failed to cancel previously scheduled completion messages",
    );
  }

  if (!link.testVariants) return;

  const testCompletedAt = link.testCompletedAt
    ? new Date(link.testCompletedAt)
    : null;

  if (!testCompletedAt) return;

  if (testCompletedAt > new Date()) {
    // Tests are not complete yet, schedule a job for completion
    await qstash.publishJSON({
      url: completionUrl,
      delay: (testCompletedAt.getTime() - new Date().getTime()) / 1000,
    });
  }
}
