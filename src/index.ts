import {
  File,
  Type,
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
} from "@google/genai";
import { Hono } from "hono";
import { getConnInfo } from "hono/cloudflare-workers";

import { supabase } from "./supabase";

const PROMPT = `
You are an expert Pokédex AI with complete knowledge of all official Pokémon across generations 1–9.

Your task: Identify which Pokémon the uploaded image most closely resembles.

---

STEP 1 — Understand what the image shows
Determine the subject: real animal, plant, object, food, landscape feature, mythical creature, drawn character, etc.

STEP 2 — Build your candidate list
Think broadly across ALL 9 generations. Ask yourself:
- Which Pokémon were directly inspired by this type of animal, plant, or object?
- Which Pokémon share the most visual traits with it?

Examples to guide you:
- Real cat → Meowth, Persian, Skitty, Glameow, Purrloin, Espurr, Litten, Sprigatito…
- Real turtle → Squirtle, Blastoise, Turtwig, Tirtouga…
- Real bear → Teddiursa, Ursaring, Cubchoo, Bewear…
- Mushroom → Paras, Parasect, Foongus, Amoonguss, Shroomish…
- Thunder / lightning shape → Pikachu, Raichu, Jolteon, Electrike…
- Rock / boulder → Geodude, Graveler, Golem, Rolycoly, Stonjourner…

STEP 3 — Compare visually
For each candidate, evaluate:
- Body shape and silhouette
- Color palette and markings
- Distinctive features (ears, tail, horns, limbs, fins, wings, etc.)
- Size proportions and posture
- Texture and surface patterns

STEP 4 — Pick the single best match
Choose the one Pokémon with the strongest overall visual resemblance. Prioritise shape and colour over species inspiration alone.

STEP 5 — Return your answer
Output ONLY valid JSON in this exact format:
{
  "dexNumber": "25",
  "name": "pikachu"
}

Rules:
- dexNumber is the National Pokédex number as a string, no leading zeros
- name is lowercase, no spaces (use hyphen for hyphenated names e.g. "mr-mime")
- If there is genuinely no reasonable Pokémon match, return: { "dexNumber": "undefined", "name": "undefined" }
- No explanation, no extra text — JSON only
`;

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
];

const MAX_RETRIES = 3;
const MAX_FILE_SIZE_MB = 25;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY environment variable is not set");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

type PokemonResult = { dexNumber: string; name: string };

const app = new Hono();

app.get("/", (c) => {
  return c.json({ success: true, message: "Pikachu" }, 200);
});

app.post("/pokedex", async (c) => {
  let uploadedFileName: string | undefined;

  try {
    const body = await c.req.parseBody();
    const picture: any = body["mon"];
    const connInfo = getConnInfo(c).remote.address || "unknown";

    if (!picture || !picture.type) {
      console.error(`Invalid picture: ${picture} | From: ${connInfo}`);
      return c.json(
        { success: false, message: "Invalid picture, try again" },
        400,
      );
    }

    if (!ALLOWED_MIME_TYPES.includes(picture.type)) {
      return c.json(
        { success: false, message: `Unsupported file type: ${picture.type}` },
        415,
      );
    }

    if (picture.size > MAX_FILE_SIZE_BYTES) {
      return c.json(
        {
          success: false,
          message: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB`,
        },
        413,
      );
    }

    console.log(
      `New pokédex request: ${picture?.name} - ${picture?.size} bytes (${(picture.size / (1024 * 1024)).toFixed(2)} MB) | From: ${connInfo}`,
    );

    const uploadedFile: File = await ai.files.upload({
      file: picture,
      config: { mimeType: picture.type },
    });
    uploadedFileName = uploadedFile.name as string;

    let attempts = 0;
    let validResponse = false;
    let result: PokemonResult[] = [];

    for (attempts = 1; attempts <= MAX_RETRIES; attempts++) {
      try {
        const response = await ai.models.generateContent({
          model: "gemini-3.1-flash-lite-preview",
          contents: createUserContent([
            createPartFromUri(
              uploadedFile.uri as string,
              uploadedFile.mimeType as string,
            ),
            PROMPT,
          ]),
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  dexNumber: {
                    type: Type.STRING,
                    description: "National Pokédex number",
                    nullable: false,
                  },
                  name: {
                    type: Type.STRING,
                    description: "Pokémon name in lowercase",
                    nullable: false,
                  },
                },
                required: ["dexNumber", "name"],
              },
            },
          },
        });

        const parsed = JSON.parse(response.text || "[]");

        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed[0].name &&
          parsed[0].dexNumber
        ) {
          result = parsed;
          validResponse = true;
          console.log(
            `Pokédex identified on attempt ${attempts}: #${result[0].dexNumber} ${result[0].name}`,
          );
          break;
        } else {
          console.warn(`Attempt ${attempts}: Invalid response format`);
        }
      } catch (parseError) {
        console.error(
          `Attempt ${attempts}: Error parsing response:`,
          parseError,
        );
      }

      if (attempts < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2 ** attempts * 250));
      }
    }

    ai.files
      .delete({ name: uploadedFileName })
      .catch((err) => console.error("Failed to delete Gemini file:", err));

    if (!validResponse) {
      console.error(`Failed to identify Pokémon after ${MAX_RETRIES} attempts`);

      const ext = picture.type.split("/")[1] || "jpg";
      const failFileName = `undefined-${Math.random().toString(36).substring(2, 10)}.${ext}`;

      await supabase.storage
        .from("pokedex-images")
        .upload(failFileName, picture, {
          upsert: false,
          contentType: picture.type,
        })
        .catch((e: any) => console.error("Supabase upload error:", e));

      return c.json(
        {
          success: false,
          message: "Failed to identify Pokémon after multiple attempts",
        },
        500,
      );
    }

    const ext = picture.type.split("/")[1] || "jpg";
    const fileName = `${result[0].name}-${Math.random().toString(36).substring(2, 10)}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("pokedex-images")
      .upload(fileName, picture, { upsert: false, contentType: picture.type });

    if (uploadError) {
      console.error("Supabase image upload error:", uploadError);
    }

    return c.json({ success: true, message: result }, 200);
  } catch (error) {
    console.error("Error processing request:", error);

    if (uploadedFileName) {
      ai.files.delete({ name: uploadedFileName }).catch(() => {});
    }

    return c.json(
      {
        success: false,
        message: "An error occurred while processing your request",
      },
      500,
    );
  }
});

export default app;
