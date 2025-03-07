import { createId } from "@/lib/api/create-id";
import { addDomainToVercel } from "@/lib/api/domains";
import { handleAndReturnErrorResponse } from "@/lib/api/errors";
import { bulkCreateLinks, createLink, processLink } from "@/lib/api/links";
import { qstash } from "@/lib/cron";
import { verifyQstashSignature } from "@/lib/cron/verify-qstash";
import { storage } from "@/lib/storage";
import { ProcessedLinkProps, WorkspaceProps } from "@/lib/types";
import { redis } from "@/lib/upstash";
import { linkMappingSchema } from "@/lib/zod/schemas/import-csv";
import { createLinkBodySchema } from "@/lib/zod/schemas/links";
import { randomBadgeColor } from "@/ui/links/tag-badge";
import { prisma } from "@dub/prisma";
import {
  APP_DOMAIN_WITH_NGROK,
  DEFAULT_LINK_PROPS,
  DUB_DOMAINS_ARRAY,
  linkConstructorSimple,
  log,
  normalizeString,
  parseDateTime,
} from "@dub/utils";
import { NextResponse } from "next/server";
import Papa from "papaparse";
import { Readable } from "stream";
import { z } from "zod";
import { sendCsvImportEmails } from "./utils";

export const dynamic = "force-dynamic";

const payloadSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  folderId: z.string().nullable(),
  url: z.string(),
  mapping: linkMappingSchema,
});

interface MapperResult {
  success: boolean;
  error?: string;
  data?: {
    domain: string;
    key: string;
    url: string;
    title?: string;
    description?: string;
    tags?: string[];
    createdAt?: Date;
  };
}

interface ErrorLink {
  domain: string;
  key: string;
  error: string;
}

const MAX_ROWS_PER_EXECUTION = 25; // Number of rows to process per execution

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();

    await verifyQstashSignature({
      req,
      rawBody,
    });

    const body = JSON.parse(rawBody);
    const payload = payloadSchema.parse(body);
    const { id, url, mapping, workspaceId } = payload;

    if (!id || !url) {
      throw new Error("Missing ID or URL for the import file.");
    }

    const redisKey = `import:csv:${workspaceId}:${id}`;
    const cursor = parseInt((await redis.get(`${redisKey}:cursor`)) || "0");

    const response = await storage.fetch(url);
    if (!response || !response.body) {
      throw new Error("CSV import file not found.");
    }

    let mappedLinks: MapperResult[] = []; // Stores processed rows
    let currentRow = 0; // Tracks both current position and processed count
    let isComplete = false; // We've reached the end of the file

    await new Promise((resolve, reject) => {
      Papa.parse(Readable.fromWeb(response.body as any), {
        header: true,
        skipEmptyLines: true,
        worker: false,
        complete: (results) => {
          isComplete = currentRow >= results.data.length;
          resolve(results);
        },
        error: reject,
        step: async (results: { data: Record<string, string> }, parser) => {
          parser.pause();

          // Skip rows until we reach our cursor position
          if (currentRow < cursor) {
            currentRow++;
            parser.resume();
            return;
          }

          if (currentRow - cursor >= MAX_ROWS_PER_EXECUTION) {
            parser.abort();
            return;
          }

          mappedLinks.push(mapCsvRowToLink(results.data, mapping));

          currentRow++;

          await redis.set(`${redisKey}:cursor`, currentRow);

          parser.resume();
        },
      });
    });

    await processMappedLinks({
      mappedLinks,
      payload,
    });

    console.log({
      isComplete,
    });

    // If we processed the maximum rows and haven't reached the end, trigger next batch
    if (currentRow - cursor >= MAX_ROWS_PER_EXECUTION && !isComplete) {
      await qstash.publishJSON({
        url: `${APP_DOMAIN_WITH_NGROK}/api/cron/import/csv`,
        body: payload,
      });
    } else {
      const errorLinks = await redis.lrange<ErrorLink>(
        `${redisKey}:failed`,
        0,
        -1,
      );

      const createdCount = parseInt(
        (await redis.get(`${redisKey}:created`)) || "0",
      );

      const domains = await redis.smembers(`${redisKey}:domains`);

      console.log({
        domains,
        createdCount,
        errorLinks,
      });

      await sendCsvImportEmails({
        workspaceId,
        count: createdCount,
        domains,
        errorLinks,
      });

      const results = await Promise.allSettled([
        redis.del(`${redisKey}:cursor`),
        redis.del(`${redisKey}:created`),
        redis.del(`${redisKey}:failed`),
        redis.del(`${redisKey}:domains`),
        storage.delete(url),
      ]);

      results.forEach((result, idx) => {
        if (result.status === "rejected") {
          console.error(
            `Error clearing CSV import data (${idx})`,
            result.reason,
          );
        }
      });
    }

    return NextResponse.json("OK");
  } catch (error) {
    await log({
      message: `Error importing CSV links: ${error.message}`,
      type: "cron",
    });

    return handleAndReturnErrorResponse(error);
  }
}

const mapCsvRowToLink = (
  row: Record<string, string>,
  mapping: z.infer<typeof linkMappingSchema>,
): MapperResult => {
  try {
    // Helper function to get value from CSV row using case-insensitive matching
    const getValueByKey = (targetKey: string) => {
      const key = Object.keys(row).find(
        (k) => normalizeString(k) === normalizeString(targetKey),
      );

      return key ? row[key].trim() : "";
    };

    const linkValue = getValueByKey(mapping.link);
    const urlValue = getValueByKey(mapping.url);

    if (!linkValue) {
      return {
        success: false,
        error: "Missing required field: link",
      };
    }

    if (!urlValue) {
      return {
        success: false,
        error: "Missing required field: url",
      };
    }

    const [domain, ...keyParts] = linkValue.split("/");
    const key = keyParts.join("/") || "_root";

    try {
      new URL(urlValue);
    } catch {
      return {
        success: false,
        error: `Invalid URL format: ${urlValue}`,
      };
    }

    const link: MapperResult["data"] = {
      domain,
      key,
      url: urlValue,
    };

    if (mapping.title) {
      const title = getValueByKey(mapping.title);

      if (title) {
        link.title = title;
      }
    }

    if (mapping.description) {
      const description = getValueByKey(mapping.description);

      if (description) {
        link.description = description;
      }
    }

    if (mapping.createdAt) {
      const createdAt = getValueByKey(mapping.createdAt);

      if (createdAt) {
        const date = parseDateTime(createdAt);

        if (date) {
          link.createdAt = date;
        }
      }
    }

    if (mapping.tags) {
      const tags = getValueByKey(mapping.tags);

      if (tags) {
        link.tags = tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
          .map((tag) => normalizeString(tag));
      }
    }

    return {
      success: true,
      data: link,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
};

const processMappedLinks = async ({
  mappedLinks,
  payload,
}: {
  mappedLinks: MapperResult[];
  payload: z.infer<typeof payloadSchema>;
}) => {
  const { id, workspaceId, userId, folderId } = payload;
  const redisKey = `import:csv:${workspaceId}:${id}`;

  if (mappedLinks.length === 0) {
    console.log("No links to process.");
    return;
  }

  const failedMappings = mappedLinks.filter(
    (result): result is { success: false; error: string } =>
      !result.success && !!result.error,
  );

  console.log({
    failedMappings,
  });

  const successfulMappings = mappedLinks.filter(
    (
      result,
    ): result is { success: true; data: NonNullable<MapperResult["data"]> } =>
      result.success && !!result.data,
  );

  //// Process the tags ////
  const selectedTags = successfulMappings
    .map((result) => result.data.tags)
    .flat()
    .filter((tag): tag is string => Boolean(tag));

  const tags = await prisma.tag.findMany({
    where: {
      projectId: workspaceId,
    },
    select: {
      id: true,
      name: true,
    },
  });

  const tagsNotInWorkspace = selectedTags.filter(
    (tag) => !tags.some((t) => t.name.toLowerCase() === tag.toLowerCase()),
  );

  if (tagsNotInWorkspace.length > 0) {
    await prisma.tag.createMany({
      data: tagsNotInWorkspace.map((name) => ({
        id: createId({ prefix: "tag_" }),
        projectId: workspaceId,
        name,
        color: randomBadgeColor(),
      })),
      skipDuplicates: true,
    });
  }

  //// Process the domains ////
  const selectedDomains = successfulMappings
    .map((result) => result.data.domain)
    .filter((domain): domain is string => Boolean(domain));

  const domains = await prisma.domain.findMany({
    where: {
      projectId: workspaceId,
    },
  });

  const domainsNotInWorkspace = selectedDomains.filter(
    (domain) =>
      !domains.some((d) => d.slug === domain) &&
      !DUB_DOMAINS_ARRAY.includes(domain),
  );

  if (domainsNotInWorkspace.length > 0) {
    await Promise.allSettled([
      prisma.domain.createMany({
        data: domainsNotInWorkspace.map((slug) => ({
          id: createId({ prefix: "dom_" }),
          projectId: workspaceId,
          slug,
          primary: false,
        })),
        skipDuplicates: true,
      }),

      domainsNotInWorkspace.map((domain) => addDomainToVercel(domain)),

      domainsNotInWorkspace.map((domain) =>
        createLink({
          ...DEFAULT_LINK_PROPS,
          projectId: workspaceId,
          userId,
          domain,
          key: "_root",
          url: "",
          tags: undefined,
        }),
      ),
    ]);
  }

  if (selectedDomains.length > 0) {
    await redis.sadd(`${redisKey}:domains`, ...selectedDomains);
  }

  //// Process the links ////
  let linksToCreate = successfulMappings.map((result) => result.data);

  const existingLinks = await prisma.link.findMany({
    where: {
      projectId: workspaceId,
      shortLink: {
        in: linksToCreate.map((link) => linkConstructorSimple(link)),
      },
    },
    select: {
      shortLink: true,
    },
  });

  console.log({
    existingLinks,
  });

  linksToCreate = linksToCreate.filter(
    (link) =>
      !existingLinks.some((l) => l.shortLink === linkConstructorSimple(link)),
  );

  const workspace = await prisma.project.findUniqueOrThrow({
    where: {
      id: workspaceId,
    },
    select: {
      id: true,
      plan: true,
    },
  });

  const processedLinks = await Promise.all(
    linksToCreate.map(({ tags, ...link }) =>
      processLink({
        payload: {
          ...createLinkBodySchema.parse({
            ...link,
            tagNames: tags || undefined,
            folderId,
          }),
        },
        workspace: {
          id: workspaceId,
          plan: workspace.plan as WorkspaceProps["plan"],
        },
        userId,
        bulk: true,
      }),
    ),
  );

  const validLinks = processedLinks
    .filter(({ error }) => error == null)
    .map(({ link }) => link);

  const errorLinks = processedLinks
    .filter(({ error }) => error != null)
    .map(({ link: { domain, key }, error }) => ({
      domain,
      key,
      error,
    }));

  if (validLinks.length > 0) {
    await bulkCreateLinks({
      links: validLinks as ProcessedLinkProps[],
    });

    await redis.incrby(`${redisKey}:created`, validLinks.length);
  }

  if (errorLinks.length > 0) {
    await redis.rpush(`${redisKey}:failed`, ...errorLinks);
  }
};
