// api/webhook.js

import { Telegraf } from "telegraf";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import dotenv from "dotenv";

// Load environment variables locally (Vercel loads them automatically)
dotenv.config();

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CREATOR_NAME = "Eli Bautista";

// --- GOOGLE SHEETS CONFIG ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;

// -------------------------------------------------------------------
// 1. Client Setup & Authentication (WITH DEBUG LOGS)
// -------------------------------------------------------------------

const bot = new Telegraf(BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const model = "gemini-2.5-flash";

// Fail-safe check for Vercel logs
if (!BOT_TOKEN || !GEMINI_API_KEY || !SPREADSHEET_ID || !GOOGLE_PRIVATE_KEY) {
  console.error("FATAL: Configuration variables are missing.");
}

// Sheets Auth Setup
const privateKeyFormatted = GOOGLE_PRIVATE_KEY
  ? GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
  : "";

// --- VERCEL DEBUG LOGS START ---
console.log("--- ENV CHECK START ---");
console.log(`SHEET ID: ${SPREADSHEET_ID}`);
console.log(`Client Email: ${GOOGLE_CLIENT_EMAIL}`);
console.log(
  `Private Key Length: ${GOOGLE_PRIVATE_KEY ? GOOGLE_PRIVATE_KEY.length : "0"}`
);
console.log(
  `Private Key Start: ${
    GOOGLE_PRIVATE_KEY ? GOOGLE_PRIVATE_KEY.substring(0, 50) : "N/A"
  }`
);
console.log(
  `Formatted Key Newline Count: ${
    (privateKeyFormatted.match(/\n/g) || []).length
  }`
);
console.log("--- ENV CHECK END ---");
// --- VERCEL DEBUG LOGS END ---

const auth = new google.auth.JWT({
  email: GOOGLE_CLIENT_EMAIL,
  key: privateKeyFormatted,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

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
// 2. Google Sheets Functions
// -------------------------------------------------------------------

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

/**
 * Appends records to the Google Sheet.
 */
const appendRecordsToSheet = async (records) => {
  const rows = records.map((r) => [
    r.date,
    r.description,
    r.amount,
    r.category,
  ]);

  // *** This is the line that throws the Sheets API authentication error ***
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:D`,
    valueInputOption: "USER_ENTERED",
    resource: {
      values: rows,
    },
  });
};

/**
 * Fetches all data from the sheet and calculates statistics.
 */
const getStatsFromSheet = async () => {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:D`,
  });

  const rows = response.data.values ? response.data.values.slice(1) : [];

  let totalAmount = 0;
  const categoryTotals = {};
  let recordCount = 0;

  for (const row of rows) {
    const amount = parseFloat(row[2]);
    const category = row[3] || "Other";

    if (!isNaN(amount)) {
      totalAmount += amount;
      recordCount++;
      categoryTotals[category] = (categoryTotals[category] || 0) + amount;
    }
  }

  if (recordCount === 0) {
    return { summary: "No expenses found in Google Sheet." };
  }

  const averageExpense = totalAmount / recordCount;
  const topCategory = Object.entries(categoryTotals).reduce(
    (a, b) => (a[1] > b[1] ? a : b),
    ["", 0]
  );

  let categoryBreakdown = Object.entries(categoryTotals)
    .map(([cat, sum]) => `\n   - ${cat}: ₱${sum.toFixed(2)}`)
    .join("");

  const summary = `
📊 **KwentaKo Statistics Summary**
---
* **Total Expenses Recorded:** ${recordCount}
* **Total Spending (Lifetime):** ₱${totalAmount.toFixed(2)}
* **Average Expense Amount:** ₱${averageExpense.toFixed(2)}
* **Top Category:** ${topCategory[0]} (₱${topCategory[1].toFixed(2)})

**Category Breakdown:**${categoryBreakdown}

📁 **Data Source:** Google Sheet
* **Created by:** ${CREATOR_NAME}
    `;

  return { summary };
};

// -------------------------------------------------------------------
// 4. Bot Commands and Handlers
// -------------------------------------------------------------------

bot.start(async (ctx) => {
  const welcomeMessage = `
👋 Welcome to KwentaKo!
    
Simply send me your expenses, and **Gemini AI** will log them into your Google Sheet. Currency is assumed to be **Philippine Peso (₱)**.

✨ *Created by ${CREATOR_NAME}*
    `;
  ctx.replyWithMarkdown(welcomeMessage);
});

bot.help(async (ctx) => {
  const helpMessage = `
📚 **Available Commands:**
* \`/download_csv\`: Sends you the latest statistics and a download link.

Bot created by **${CREATOR_NAME}**.
    `;
  ctx.replyWithMarkdown(helpMessage);
});

// Main text handler
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  try {
    await ctx.reply("🤖 Analyzing expense with Gemini AI...");

    const newRecords = await parseExpensesWithAI(text);

    if (newRecords.length === 0) {
      return ctx.reply(
        "AI could not extract any expenses. Please try a different phrasing, specifying the amount clearly."
      );
    }

    // --- WRITE TO GOOGLE SHEETS ---
    await appendRecordsToSheet(newRecords);

    const total = newRecords.reduce((acc, curr) => acc + curr.amount, 0);
    ctx.reply(
      `✅ Saved ${
        newRecords.length
      } items to Google Sheet. Total: ₱${total.toFixed(2)}`
    );
  } catch (error) {
    // Log the full error to Vercel logs for inspection
    // Log the whole error object to make debugging easier in logs
    console.error("Error processing with Sheets:", error);

    // Send a safer, more helpful message to the user when running in debug mode.
    // In production we keep the generic message to avoid leaking sensitive info.
    const isDebug =
      process.env.DEBUG === "true" || process.env.NODE_ENV !== "production";

    const baseMessage =
      "Error saving data. Check your Sheet ID, Permissions, or Vercel logs.";

    if (isDebug) {
      // Keep the message concise for the user but include the error message and
      // a short, truncated stack preview to speed up triage during development.
      const errMessage = error && error.message ? error.message : String(error);
      const stackPreview =
        error && error.stack
          ? error.stack.split("\n").slice(0, 4).join("\n")
          : null;

      const debugReply = stackPreview
        ? `Error saving data: ${errMessage}\n\nStack (truncated):\n${stackPreview}`
        : `Error saving data: ${errMessage}`;

      // Use await here because we're inside an async handler
      await ctx.reply(debugReply);
    } else {
      // Production: do not include internals in the reply
      await ctx.reply(baseMessage);
    }
  }
});

// Command to download the data
bot.command("download_csv", async (ctx) => {
  try {
    const { summary } = await getStatsFromSheet();

    await ctx.replyWithMarkdown(summary);

    const viewUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;
    const downloadUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=xlsx&id=${SPREADSHEET_ID}`;

    await ctx.replyWithHTML(`
📥 **View or Download Your Data:**
* **View Online:** <a href="${viewUrl}">Open Google Sheet</a>
* **Download Excel (.xlsx):** <a href="${downloadUrl}">Download File</a>
        `);
  } catch (error) {
    console.error("Error with Google Sheets API:", error.message);
    ctx.reply(
      "Could not access Google Sheets. Check your API key and Sheet ID/Permissions."
    );
  }
});

// -------------------------------------------------------------------
// 5. Vercel Handler Function (The Webhook Entry Point)
// -------------------------------------------------------------------

// --- FIX: Telegraf handles the response, so we don't send a second one ---
export default async (req, res) => {
  try {
    // Handle the incoming webhook from Telegram
    await bot.handleUpdate(req.body, res);

    // Vercel only needs the 200 OK signal, which Telegraf often handles implicitly.
    // We will send it manually IF Telegraf hasn't already crashed or responded.
    // We MUST check if headers have been sent before sending the final status.
    if (!res.headersSent) {
      res.status(200).send("OK");
    }
  } catch (error) {
    console.error("Vercel Webhook execution error:", error.message);
    // Ensure we only send an error if we haven't already replied via Telegram
    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  }
};
