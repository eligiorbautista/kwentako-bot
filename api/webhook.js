// api/webhook.js

import { Telegraf } from "telegraf";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import dotenv from "dotenv";

// Load environment variables locally
dotenv.config();

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const BASE64_CREDENTIALS = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64; // The robust key

// -------------------------------------------------------------------
// 1. Client Setup & Authentication (FINAL ROBUST METHOD)
// -------------------------------------------------------------------

const bot = new Telegraf(BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const model = "gemini-2.5-flash";

let sheets;
let authError = null;

try {
  if (!BASE64_CREDENTIALS) {
    throw new Error(
      "FATAL: GOOGLE_SERVICE_ACCOUNT_BASE64 variable is missing."
    );
  }

  // 1. Decode the Base64 string into a credential object
  const decodedCredentialsString = Buffer.from(
    BASE64_CREDENTIALS,
    "base64"
  ).toString("utf-8");
  const credentials = JSON.parse(decodedCredentialsString);

  // 2. Initialize JWT Client (uses credentials.client_email and credentials.private_key)
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  // 3. Initialize Sheets Client
  sheets = google.sheets({ version: "v4", auth });
  console.log("--- AUTH SUCCESS: Sheets Client Initialized ---");
} catch (error) {
  authError = error;
  console.error("FATAL AUTH ERROR:", error.message);
  // Set sheets to null to ensure subsequent API calls are blocked
  sheets = null;
}

// --- DEBUG LOGS FOR VERCEL ---
console.log("--- ENV CHECK START ---");
console.log(`SHEET ID: ${SPREADSHEET_ID}`);
console.log(`Auth Status: ${sheets ? "Initialized" : "FAILED"}`);
console.log(
  `Auth Error Type: ${authError ? authError.constructor.name : "N/A"}`
);
console.log("--- ENV CHECK END ---");
// -----------------------------

// --- Gemini Schema Definition (Rest of the code remains the same) ---
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

// ... parseExpensesWithAI (same) ...

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
  // Check for authentication failure before proceeding
  if (!sheets) {
    throw new Error(
      "FATAL: Google Sheets client failed to initialize due to credential error."
    );
  }

  const rows = records.map((r) => [
    r.date,
    r.description,
    r.amount,
    r.category,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${process.env.SHEET_NAME || "Expenses"}!A:D`,
    valueInputOption: "USER_ENTERED",
    resource: {
      values: rows,
    },
  });
};

// ... (getStatsFromSheet and all other logic remains the same) ...

const getStatsFromSheet = async () => {
  // Check for authentication failure before proceeding
  if (!sheets) {
    throw new Error(
      "FATAL: Google Sheets client failed to initialize due to credential error."
    );
  }

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${process.env.SHEET_NAME || "Expenses"}!A:D`,
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
    .map(([cat, sum]) => `\n   - ${cat}: ₱${sum.toFixed(2)}`)
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
* **Created by:** ${process.env.CREATOR_NAME || "Eli Bautista"}
    `;

  return { summary };
};

// -------------------------------------------------------------------
// 3. Bot Commands and Handlers (Error handling updated)
// -------------------------------------------------------------------

bot.start(async (ctx) => {
  const welcomeMessage = `
👋 Welcome to KwentaKo!
    
Simply send me your expenses, and **Gemini AI** will log them into your Google Sheet. Currency is assumed to be **Philippine Peso (₱)**.

✨ *Created by ${process.env.CREATOR_NAME || "Eli Bautista"}*
    `;
  ctx.replyWithMarkdown(welcomeMessage);
});

bot.help(async (ctx) => {
  const helpMessage = `
📚 **Available Commands:**
* \`/download_csv\`: Sends you the latest statistics and a download link.

Bot created by **${process.env.CREATOR_NAME || "Eli Bautista"}**.
    `;
  ctx.replyWithMarkdown(helpMessage);
});

// Main text handler
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  // Check for authentication failure first
  if (!sheets) {
    return ctx.reply(
      "Critical Error: Authentication failed. Please check Vercel logs and ensure the BASE64 key is correct."
    );
  }

  try {
    await ctx.reply("🤖 Analyzing expense with Gemini AI...");

    const newRecords = await parseExpensesWithAI(text);

    if (newRecords.length === 0) {
      return ctx.reply(
        "AI could not extract any expenses. Please try a different phrasing, specifying the amount clearly."
      );
    }

    await appendRecordsToSheet(newRecords);

    const total = newRecords.reduce((acc, curr) => acc + curr.amount, 0);
    ctx.reply(
      `✅ Saved ${
        newRecords.length
      } items to Google Sheet. Total: ₱${total.toFixed(2)}`
    );
  } catch (error) {
    // We log the full error for debugging
    console.error("Error processing with Sheets:", error);

    // This is the common 403/404/Sheet-related error response
    ctx.reply(
      "Error saving data. Check your Google Sheet ID, sharing Permissions, or Vercel logs."
    );
  }
});

// Command to download the data
bot.command("download_csv", async (ctx) => {
  // Check for authentication failure first
  if (!sheets) {
    return ctx.reply(
      "Critical Error: Authentication failed. Please check Vercel logs and ensure the BASE64 key is correct."
    );
  }
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
// 4. Vercel Handler Function (FINAL FIX FOR HTTP HEADERS)
// -------------------------------------------------------------------

export default async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);

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
