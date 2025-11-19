// api/webhook.js

import { Telegraf } from "telegraf";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import dotenv from "dotenv";
import { put, get, list } from "@vercel/blob"; // Vercel Blob Import

// Load environment variables
dotenv.config();

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BLOB_READ_WRITE_TOKEN_READ_WRITE_TOKEN =
  process.env.BLOB_READ_WRITE_TOKEN_READ_WRITE_TOKEN; // Vercel Blob Token
const CREATOR_NAME = "Eli Bautista";
const BLOB_FILE_KEY = "expenses/kwentako_data.csv";

// Fail-safe check
if (!BOT_TOKEN || !GEMINI_API_KEY || !BLOB_READ_WRITE_TOKEN) {
  console.error("FATAL: Required environment variables are missing.");
}

const bot = new Telegraf(BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const model = "gemini-2.5-flash";

// --- Gemini Schema Definition ---
const expenseSchema = z.object({
  description: z
    .string()
    .describe("A brief description of the expense item..."),
  amount: z.number().describe("The numerical value of the expense..."),
  category: z
    .enum([
      "Food",
      "Transportation",
      "Supplies",
      "Utilities",
      "Personal",
      "Other",
    ])
    .describe("The assigned expense category."),
});
const responseSchema = z.array(expenseSchema);
const jsonSchema = zodToJsonSchema(responseSchema);

// -------------------------------------------------------------------
// 3. VERCEL BLOB & GEMINI HELPERS
// -------------------------------------------------------------------

/**
 * Reads the existing CSV content from the Vercel Blob store.
 * Initializes with headers if the file is not found (404).
 * @returns {string} The raw CSV content.
 */
const readBlobContent = async () => {
  try {
    const response = await get(BLOB_FILE_KEY, {
      token: BLOB_READ_WRITE_TOKEN_READ_WRITE_TOKEN,
      cache: "no-store",
      type: "text",
    });

    // returns the raw content string
    return await response.text();
  } catch (error) {
    // If the file doesn't exist (404), return the initial header row
    if (error.status === 404 || error.message.includes("file not found")) {
      return "Date,Description,Amount (PHP),Category\n";
    }
    throw new Error(`Blob Read Error: ${error.message}`);
  }
};

/**
 * Writes the updated CSV data back to Vercel Blob.
 * @param {string} newContent - The full, updated CSV content.
 * @returns {object} The blob metadata, including the public URL.
 */
const writeBlobContent = async (newContent) => {
  // The 'put' operation automatically overwrites (replaces) the existing file
  return await put(BLOB_FILE_KEY, newContent, {
    token: BLOB_READ_WRITE_TOKEN_READ_WRITE_TOKEN,
    access: "public", // Set to public so the user can download it directly
    contentType: "text/csv",
  });
};

/**
 * Uses Gemini to parse Philippine expense text into structured JSON data.
 */
const parseExpensesWithAI = async (text) => {
  const prompt = `You are an expert financial assistant operating in the Philippines. Analyze the following user input and extract all separate expenses. Assume all currency is in Philippine Peso (PHP) unless otherwise specified. Input: "${text}"`;

  const response = await ai.models.generateContent({
    model: model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: jsonSchema,
    },
  });

  const rawJson = response.text.trim();
  const parsedData = JSON.parse(rawJson);
  const date = new Date().toLocaleDateString("en-PH");

  return parsedData.map((record) => ({ ...record, date }));
};

// -------------------------------------------------------------------
// 4. Bot Commands and Handlers
// -------------------------------------------------------------------

bot.start(async (ctx) => {
  const welcomeMessage = `
👋 Welcome to KwentaKo!
    
Simply send me your expenses. I will log them to secure Vercel Blob storage and send you the updated download link.

✨ *Created by ${CREATOR_NAME}*
    `;
  ctx.replyWithMarkdown(welcomeMessage);
});

// Main text handler
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  try {
    await ctx.reply("🤖 Analyzing expense with Gemini AI...");

    // 1. PARSE NEW EXPENSES
    const newRecords = await parseExpensesWithAI(text);
    if (newRecords.length === 0) {
      return ctx.reply("AI could not extract any expenses.");
    }

    // 2. READ EXISTING BLOB DATA
    const existingContent = await readBlobContent();

    // 3. Extract existing data lines (skip header)
    const contentLines = existingContent.split("\n");
    const header = contentLines[0];
    const existingData = contentLines
      .slice(1)
      .filter((line) => line.trim() !== "");

    // 4. FORMAT AND COMBINE NEW DATA
    const newCsvLines = newRecords.map(
      (r) => `${r.date},"${r.description}",${r.amount},${r.category}`
    );

    const allData = [...existingData, ...newCsvLines];
    const updatedContent = [header, ...allData].join("\n");

    // 5. WRITE UPDATED CSV BACK TO BLOB
    const blobMetadata = await writeBlobContent(updatedContent);

    // 6. CONFIRMATION AND DOWNLOAD LINK
    const total = newRecords.reduce((acc, curr) => acc + curr.amount, 0);

    await ctx.replyWithHTML(
      `✅ Saved ${newRecords.length} items. Total: ₱${total.toFixed(2)}` +
        `\n\n📥 **Download CSV:** <a href="${blobMetadata.url}">Click to get file</a>`
    );
  } catch (error) {
    console.error("Critical Blob/Gemini Error:", error);
    ctx.reply(
      `A critical error occurred while processing (Blob/Token error). Check Vercel logs.`
    );
  }
});

// -------------------------------------------------------------------
// 5. Vercel Handler Function (The Webhook Entry Point)
// -------------------------------------------------------------------

export default async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);

    // Send 200 OK ONLY if the response hasn't been sent by ctx.reply inside the handlers
    if (!res.headersSent) {
      res.status(200).send("OK");
    }
  } catch (error) {
    console.error("Vercel Webhook execution error:", error.message);

    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  }
};
