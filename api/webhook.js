// api/webhook.js

import { Telegraf } from "telegraf";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import dotenv from "dotenv";
import { put, getDownloadUrl, list, del } from "@vercel/blob";

// Load environment variables
dotenv.config();

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- FIX: Using the Vercel-generated variable name with fallbacks ---
const BLOB_READ_WRITE_TOKEN =
  process.env.BLOB_READ_WRITE_TOKEN_READ_WRITE_TOKEN ||
  process.env.BLOB_READ_WRITE_TOKEN ||
  process.env.VERCEL_BLOB_READ_WRITE_TOKEN;

const CREATOR_NAME = "Eli Bautista";
const BLOB_FILE_KEY = "expenses/kwentako_data.csv";

// Fail-safe check with detailed logging
if (!BOT_TOKEN || !GEMINI_API_KEY || !BLOB_READ_WRITE_TOKEN) {
  console.error("FATAL: Required environment variables are missing.");
  console.error("BOT_TOKEN:", BOT_TOKEN ? "✓ Present" : "✗ Missing");
  console.error("GEMINI_API_KEY:", GEMINI_API_KEY ? "✓ Present" : "✗ Missing");
  console.error(
    "BLOB_READ_WRITE_TOKEN:",
    BLOB_READ_WRITE_TOKEN ? "✓ Present" : "✗ Missing"
  );
  console.error(
    "Available env keys:",
    Object.keys(process.env).filter((key) => key.includes("BLOB"))
  );
}

const bot = new Telegraf(BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const model = "gemini-2.5-flash"; // Lighter model, sufficient for expense parsing

// Simple message tracking to prevent duplicates
const processedMessages = new Set();
const MESSAGE_CACHE_SIZE = 100;

// Rate limiting for Gemini API
let lastGeminiCall = 0;
const GEMINI_MIN_DELAY = 2000; // 2 seconds between calls

// --- Simplified Schema for Better Performance ---
const expenseSchema = z.object({
  description: z.string().describe("Brief expense description"),
  amount: z.number().describe("Amount in PHP"),
  category: z
    .enum([
      "Food",
      "Transportation",
      "Supplies",
      "Utilities",
      "Personal",
      "Other",
    ])
    .describe("Expense category"),
});
const responseSchema = z.array(expenseSchema);

// Create a simpler, more efficient schema
const simplifiedJsonSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      description: { type: "string" },
      amount: { type: "number" },
      category: {
        type: "string",
        enum: [
          "Food",
          "Transportation",
          "Supplies",
          "Utilities",
          "Personal",
          "Other",
        ],
      },
    },
    required: ["description", "amount", "category"],
  },
};

// -------------------------------------------------------------------
// 3. CSV GENERATION & BLOB HELPERS
// -------------------------------------------------------------------

/**
 * Generates initial CSV with metadata and headers
 */
const generateInitialCSV = () => {
  const now = new Date();
  const timestamp = now.toISOString();

  return `KwentaKo Expense Tracker by Eli Bautista
Generated: ${timestamp} 
Total Expenses: PHP 0.00
Total Records: 0

CATEGORY BREAKDOWN:
Date,Description,Amount (PHP),Category
Food: PHP 0.00 (0%)
Transportation: PHP 0.00 (0%)
Supplies: PHP 0.00 (0%)
Utilities: PHP 0.00 (0%)
Personal: PHP 0.00 (0%)
Other: PHP 0.00 (0%)

`;
};

/**
 * Generates complete CSV with data, metadata and statistics
 */
const generateCompleteCSV = (expenseRecords) => {
  const now = new Date();
  const timestamp = now.toISOString();

  // Calculate statistics
  const total = expenseRecords.reduce((sum, record) => sum + record.amount, 0);
  const categoryTotals = {};
  const categories = [
    "Food",
    "Transportation",
    "Supplies",
    "Utilities",
    "Personal",
    "Other",
  ];

  // Initialize categories
  categories.forEach((cat) => (categoryTotals[cat] = 0));

  // Calculate category totals
  expenseRecords.forEach((record) => {
    categoryTotals[record.category] =
      (categoryTotals[record.category] || 0) + record.amount;
  });

  // Generate category breakdown with percentages
  const categoryBreakdown = categories
    .map((cat) => {
      const amount = categoryTotals[cat] || 0;
      const percentage =
        total > 0 ? ((amount / total) * 100).toFixed(1) : "0.0";
      return `${cat}: PHP ${amount.toFixed(2)} (${percentage}%)`;
    })
    .join("\n");

  // Generate CSV header with metadata
  const header = `KwentaKo Expense Tracker
Generated: ${timestamp}
Creator: ${CREATOR_NAME}
Total Expenses: PHP ${total.toFixed(2)}
Total Records: ${expenseRecords.length}

CATEGORY BREAKDOWN:
${categoryBreakdown}

Date,Description,Amount (PHP),Category`;

  // Generate data rows
  const dataRows = expenseRecords.map(
    (record) =>
      `${record.date},"${record.description}",${record.amount},${record.category}`
  );

  return [header, ...dataRows].join("\n") + "\n";
};

/**
 * Parses existing CSV content and extracts expense records
 */
const parseExistingCSV = (csvContent) => {
  const lines = csvContent.split("\n");
  const expenses = [];

  let inDataSection = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip empty lines and comments
    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    // Check if we've reached the header row
    if (trimmedLine.startsWith("Date,Description,Amount")) {
      inDataSection = true;
      continue;
    }

    // Parse data rows
    if (inDataSection && trimmedLine) {
      const parts = trimmedLine.split(",");
      if (parts.length >= 4) {
        const date = parts[0];
        const description = parts[1].replace(/"/g, ""); // Remove quotes
        const amount = parseFloat(parts[2]);
        const category = parts[3];

        if (!isNaN(amount)) {
          expenses.push({ date, description, amount, category });
        }
      }
    }
  }

  return expenses;
};

// -------------------------------------------------------------------
// 4. VERCEL BLOB HELPERS
// -------------------------------------------------------------------

/**
 * Reads the existing CSV content from the Vercel Blob store.
 * @returns {string} The raw CSV content.
 */
const readBlobContent = async () => {
  try {
    // Method 1: List blobs and find the most recent one
    const { blobs } = await list({
      token: BLOB_READ_WRITE_TOKEN,
      prefix: "expenses/kwentako_data_", // Look for our timestamped files
    });

    console.log(
      "Listed blobs:",
      blobs?.map((b) => ({ pathname: b.pathname, uploadedAt: b.uploadedAt }))
    );

    // Find the most recent blob (highest timestamp)
    let targetBlob = null;
    if (blobs && blobs.length > 0) {
      // Sort by upload date (most recent first)
      const sortedBlobs = blobs.sort(
        (a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)
      );
      targetBlob = sortedBlobs[0]; // Get the most recent one
    }

    // If no blob found, return initial CSV with metadata
    if (!targetBlob) {
      console.log("No existing blob found, returning default CSV");
      return generateInitialCSV();
    }

    console.log("Found most recent blob:", {
      pathname: targetBlob.pathname,
      url: targetBlob.url,
      uploadedAt: targetBlob.uploadedAt,
    });

    // Fetch the content from the URL with cache-busting
    const response = await fetch(targetBlob.url + "?t=" + Date.now());

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const content = await response.text();
    console.log("Successfully read blob content, length:", content.length);
    console.log("Content preview:", content.substring(0, 200) + "...");
    return content;
  } catch (listError) {
    console.error(
      "List method failed, trying getDownloadUrl:",
      listError.message
    );

    // Method 2: Fallback to getDownloadUrl
    try {
      const downloadUrl = await getDownloadUrl(BLOB_FILE_KEY, {
        token: BLOB_READ_WRITE_TOKEN,
      });

      console.log("Got download URL:", downloadUrl);

      // Add cache-busting parameter
      const response = await fetch(downloadUrl + "?t=" + Date.now());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const content = await response.text();
      console.log(
        "Successfully read blob content via downloadUrl, length:",
        content.length
      );
      return content;
    } catch (downloadError) {
      console.error("Both methods failed:", downloadError.message);

      // If the file doesn't exist or we can't access it, return the initial header row
      if (
        downloadError.message.includes("404") ||
        downloadError.message.includes("file not found") ||
        downloadError.message.includes("BlobNotFoundError") ||
        downloadError.message.includes("Invalid URL") ||
        listError.message.includes("404") ||
        listError.message.includes("file not found")
      ) {
        console.log("Blob doesn't exist, returning default CSV");
        return generateInitialCSV();
      }

      throw new Error(`Blob Read Error: ${downloadError.message}`);
    }
  }
};

/**
 * Writes the updated CSV data back to Vercel Blob.
 * @param {string} newContent - The full, updated CSV content.
 * @returns {object} The blob metadata, including the public URL.
 */
const writeBlobContent = async (newContent) => {
  console.log("Writing content to blob, length:", newContent.length);

  try {
    // SOLUTION: Use unique filename each time to guarantee fresh URL
    const timestamp = Date.now();
    const uniqueFilename = `expenses/kwentako_data_${timestamp}.csv`;

    console.log("Creating blob with unique filename:", uniqueFilename);

    const newBlob = await put(uniqueFilename, newContent, {
      token: BLOB_READ_WRITE_TOKEN,
      access: "public",
      contentType: "text/csv",
    });

    console.log("Successfully created new blob:", {
      url: newBlob.url,
      pathname: newBlob.pathname,
    });

    // Optional: Clean up old files (keep last 5)
    try {
      const { blobs } = await list({
        token: BLOB_READ_WRITE_TOKEN,
        prefix: "expenses/kwentako_data_",
      });

      if (blobs && blobs.length > 5) {
        // Sort by upload date and keep only the newest 5
        const sortedBlobs = blobs.sort(
          (a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)
        );
        const blobsToDelete = sortedBlobs.slice(5); // Delete older ones

        for (const oldBlob of blobsToDelete) {
          try {
            await del(oldBlob.pathname, { token: BLOB_READ_WRITE_TOKEN });
            console.log("Cleaned up old blob:", oldBlob.pathname);
          } catch (cleanupError) {
            console.log(
              "Cleanup failed for:",
              oldBlob.pathname,
              cleanupError.message
            );
          }
        }
      }
    } catch (cleanupError) {
      console.log(
        "Cleanup process failed (non-critical):",
        cleanupError.message
      );
    }

    return newBlob;
  } catch (error) {
    console.error("Error in writeBlobContent:", error);
    throw new Error(`Failed to write blob content: ${error.message}`);
  }
};

/**
 * Manual expense parsing as fallback when Gemini fails
 */
const parseExpensesManually = (text) => {
  const date = new Date().toLocaleDateString("en-PH");

  // Simple regex patterns for common expense formats
  const patterns = [
    // "item for 150", "lunch 200", "taxi 50"
    /(.+?)\s+(?:for|cost|price|worth|)\s*(?:php|₱|pesos?|)\s*(\d+(?:\.\d{2})?)/gi,
    // "150 for item", "200 lunch", "₱50 taxi"
    /(?:php|₱|pesos?|)\s*(\d+(?:\.\d{2})?)\s+(?:for|)\s*(.+)/gi,
    // Just numbers with context "bought something 150"
    /(.+?)\s+(\d+(?:\.\d{2})?)$/gi,
  ];

  const results = [];
  let amount = null;
  let description = text.trim();

  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 0) {
      const match = matches[0];
      if (pattern === patterns[1]) {
        // Amount first pattern
        amount = parseFloat(match[1]);
        description = match[2].trim();
      } else {
        // Description first pattern
        description = match[1].trim();
        amount = parseFloat(match[2]);
      }
      break;
    }
  }

  // If no amount found, try to extract any number
  if (!amount) {
    const numberMatch = text.match(/(\d+(?:\.\d{2})?)/);
    if (numberMatch) {
      amount = parseFloat(numberMatch[1]);
      description = text.replace(numberMatch[0], "").trim();
    }
  }

  // Default fallback
  if (!amount) {
    amount = 0;
    description = text;
  }

  // Simple category guessing
  let category = "Other";
  const lowerText = text.toLowerCase();
  if (
    lowerText.includes("food") ||
    lowerText.includes("lunch") ||
    lowerText.includes("dinner") ||
    lowerText.includes("meal") ||
    lowerText.includes("eat")
  )
    category = "Food";
  else if (
    lowerText.includes("taxi") ||
    lowerText.includes("bus") ||
    lowerText.includes("transport") ||
    lowerText.includes("fare")
  )
    category = "Transportation";
  else if (
    lowerText.includes("office") ||
    lowerText.includes("work") ||
    lowerText.includes("supplies")
  )
    category = "Supplies";
  else if (
    lowerText.includes("bill") ||
    lowerText.includes("electric") ||
    lowerText.includes("water") ||
    lowerText.includes("internet")
  )
    category = "Utilities";
  else if (
    lowerText.includes("personal") ||
    lowerText.includes("health") ||
    lowerText.includes("medical")
  )
    category = "Personal";

  return [
    { date, description: description || "Manual entry", amount, category },
  ];
};

/**
 * Uses Gemini to parse Philippine expense text into structured JSON data with retry logic.
 */
const parseExpensesWithAI = async (text, maxRetries = 3) => {
  // Input validation to reduce API load
  if (!text || text.trim().length === 0) {
    throw new Error("Empty input text");
  }

  // Rate limiting check
  const now = Date.now();
  const timeSinceLastCall = now - lastGeminiCall;
  if (timeSinceLastCall < GEMINI_MIN_DELAY) {
    const waitTime = GEMINI_MIN_DELAY - timeSinceLastCall;
    console.log(`Rate limiting: waiting ${waitTime}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
  lastGeminiCall = Date.now();

  // Limit input length to prevent excessive token usage
  const maxLength = 300; // Reduced from 500
  const trimmedText =
    text.length > maxLength ? text.substring(0, maxLength) + "..." : text;

  // Shorter, more efficient prompt
  const prompt = `Extract expenses from: "${trimmedText}". Return JSON array: [{description: string, amount: number, category: "Food"|"Transportation"|"Supplies"|"Utilities"|"Personal"|"Other"}]`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: simplifiedJsonSchema,
        },
      });

      const rawJson = response.text.trim();
      const parsedData = JSON.parse(rawJson);
      const date = new Date().toLocaleDateString("en-PH");

      return parsedData.map((record) => ({ ...record, date }));
    } catch (error) {
      console.log(
        `Gemini API attempt ${attempt}/${maxRetries} failed:`,
        error.message
      );

      // Check if it's a service unavailable error (503) or rate limit
      if (
        error.message.includes("503") ||
        error.message.includes("overloaded") ||
        error.message.includes("UNAVAILABLE") ||
        error.message.includes("rate limit") ||
        error.message.includes("429")
      ) {
        if (attempt < maxRetries) {
          // Increased exponential backoff for overloaded servers
          const waitTime = Math.pow(3, attempt) * 2000; // 6s, 18s, 54s
          console.log(
            `Server overloaded, waiting ${waitTime}ms before retry...`
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          continue;
        } else {
          // If all retries failed, fall back to manual parsing
          console.log("Gemini API exhausted, falling back to manual parsing");
          return parseExpensesManually(text);
        }
      }

      // For other errors, also fall back to manual parsing on final attempt
      if (attempt === maxRetries) {
        console.log("Final attempt failed, falling back to manual parsing");
        return parseExpensesManually(text);
      }

      // If it's not a retryable error, throw immediately
      throw error;
    }
  }
};

// -------------------------------------------------------------------
// 4. Bot Commands and Handlers
// -------------------------------------------------------------------

bot.start(async (ctx) => {
  const welcomeMessage = `
👋 Welcome to KwentaKo!
    
Simply send me your expenses. I will log them to secure Vercel Blob storage and send you the updated download link.

📝 *Available Commands:*
• Send expense messages (e.g., "lunch 150 pesos")
• \`/verify\` - Check current data status
• \`/clearData\` - Delete all stored expense data

✨ *Created by ${CREATOR_NAME}*
    `;
  ctx.replyWithMarkdown(welcomeMessage);
});

// Add verification command
bot.command("verify", async (ctx) => {
  try {
    const content = await readBlobContent();
    const lines = content.split("\n").filter((line) => line.trim() !== "");
    const recordCount =
      lines.filter((line) => !line.startsWith("#")).length - 1; // Subtract header, ignore comments

    // Get the current blob URL dynamically
    const { blobs } = await list({
      token: BLOB_READ_WRITE_TOKEN,
      prefix: "expenses/kwentako_data_",
    });

    let downloadUrl = "#";
    if (blobs && blobs.length > 0) {
      // Get the most recent blob
      const sortedBlobs = blobs.sort(
        (a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)
      );
      downloadUrl = sortedBlobs[0].url;
    }

    await ctx.replyWithHTML(
      `🔍 <b>Current CSV Status:</b>\n` +
        `📊 Total records: ${recordCount}\n` +
        `📝 File size: ${content.length} characters\n\n` +
        `📥 <a href="${downloadUrl}">Download Latest CSV</a>\n\n` +
        `<code>${content.substring(0, 1000)}${
          content.length > 1000 ? "..." : ""
        }</code>`
    );
  } catch (error) {
    ctx.reply(`❌ Error reading blob: ${error.message}`);
  }
});

// Add clear data command
bot.command("clearData", async (ctx) => {
  try {
    await ctx.reply("🗑️ Starting to clear all expense data...");

    // List all blobs with the expenses prefix
    const { blobs } = await list({
      token: BLOB_READ_WRITE_TOKEN,
      prefix: "expenses/",
    });

    if (!blobs || blobs.length === 0) {
      await ctx.reply("✅ No data found to clear. Storage is already empty.");
      return;
    }

    let deletedCount = 0;
    let errorCount = 0;

    // Delete all found blobs
    for (const blob of blobs) {
      try {
        await del(blob.pathname, { token: BLOB_READ_WRITE_TOKEN });
        deletedCount++;
        console.log(`Deleted blob: ${blob.pathname}`);
      } catch (deleteError) {
        errorCount++;
        console.error(
          `Failed to delete ${blob.pathname}:`,
          deleteError.message
        );
      }
    }

    // Provide feedback to user
    if (deletedCount > 0) {
      await ctx.replyWithHTML(
        `✅ <b>Data cleared successfully!</b>\n` +
          `🗑️ Deleted ${deletedCount} file(s)\n` +
          (errorCount > 0
            ? `⚠️ Failed to delete ${errorCount} file(s)\n`
            : "") +
          `\n📝 You can now start fresh with new expenses.`
      );
    } else {
      await ctx.reply(
        "❌ Failed to delete any files. Please try again or contact support."
      );
    }
  } catch (error) {
    console.error("Clear data error:", error);
    await ctx.reply(
      `❌ Error clearing data: ${error.message}\n` +
        `Please try again or contact support if the issue persists.`
    );
  }
});

// Main text handler
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.message.from.id;
  const messageId = ctx.message.message_id;

  // Create a unique identifier for this message
  const messageKey = `${userId}:${messageId}:${text.substring(0, 50)}`;

  // Check if we've already processed this message
  if (processedMessages.has(messageKey)) {
    console.log("Skipping duplicate message:", messageKey);
    return;
  }

  // Add to processed messages (with size limit)
  processedMessages.add(messageKey);
  if (processedMessages.size > MESSAGE_CACHE_SIZE) {
    const firstKey = processedMessages.values().next().value;
    processedMessages.delete(firstKey);
  }

  // Skip if it's a command
  if (text.startsWith("/")) return;

  // Skip if message is from the bot itself (safety check)
  if (ctx.message.from.is_bot) {
    console.log("Ignoring bot message:", text);
    return;
  }

  // Basic input validation to reduce unnecessary API calls
  if (!text || text.trim().length < 3) {
    return ctx.reply("Please provide more details about your expense.");
  }

  // Enhanced filtering for non-expense messages
  const nonExpensePatterns =
    /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|what|how|why|good|bad|nice|cool|awesome|great|perfect|done|finished|complete|stop|end|quit|exit|help|info|about)$/i;

  // Check for bot-like responses (emojis, formatted text patterns)
  const botResponsePatterns = /^[✅❌📊📥🔍🤖]/i;
  const htmlLinkPattern = /<a href=/i;
  const csvDataPattern = /^(Date|#|\d{4}-\d{2}-\d{2})/i;

  if (
    nonExpensePatterns.test(text.trim()) ||
    botResponsePatterns.test(text.trim()) ||
    htmlLinkPattern.test(text) ||
    csvDataPattern.test(text)
  ) {
    console.log("Filtered out non-expense message:", text);
    return ctx.reply(
      "I help track expenses. Please send me details like 'bought lunch 150 pesos' or 'taxi fare 80 php'."
    );
  }

  // Additional check: if message looks like a previous expense entry, skip it
  if (text.includes(',"') && text.includes(",")) {
    console.log("Skipping what appears to be CSV data:", text);
    return ctx.reply(
      "I see that looks like CSV data. Please send me new expense details in natural language."
    );
  }

  console.log(`Processing expense message from user ${userId}: "${text}"`);

  try {
    await ctx.reply("🤖 Processing your expense...");

    // 1. PARSE NEW EXPENSES (with fallback to manual parsing)
    const newRecords = await parseExpensesWithAI(text);
    if (newRecords.length === 0) {
      return ctx.reply(
        "❌ Could not extract any expenses from your message. Try being more specific about amount and description."
      );
    }

    // Check if manual parsing was used (fallback indicator)
    const isManualParsing = newRecords.some(
      (record) => record.amount === 0 || record.description === "Manual entry"
    );

    // 2. READ EXISTING BLOB DATA
    const existingContent = await readBlobContent();
    console.log("Existing content read, length:", existingContent.length);

    // 3. PARSE EXISTING EXPENSES FROM CSV
    const existingRecords = parseExistingCSV(existingContent);
    console.log("Existing expense records:", existingRecords.length);

    // 4. COMBINE ALL RECORDS
    const allRecords = [...existingRecords, ...newRecords];
    console.log("Total records after adding new:", allRecords.length);

    // 5. GENERATE COMPLETE CSV WITH METADATA
    const updatedContent = generateCompleteCSV(allRecords);
    console.log("Generated CSV content, length:", updatedContent.length);

    // 6. WRITE UPDATED CSV BACK TO BLOB (delete-first approach)
    const blobMetadata = await writeBlobContent(updatedContent);
    console.log("Blob write result:", blobMetadata);

    // 7. CALCULATE STATISTICS FOR RESPONSE
    const newTotal = newRecords.reduce((acc, curr) => acc + curr.amount, 0);
    const grandTotal = allRecords.reduce((acc, curr) => acc + curr.amount, 0);

    // Format datetime in human-readable English
    const updateTime = new Date().toLocaleString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Manila",
    });

    await ctx.replyWithHTML(
      `✅ Added ${newRecords.length} new expenses (PHP ${newTotal.toFixed(
        2
      )})\n` +
        `📊 Total expenses: ${
          allRecords.length
        } records (PHP ${grandTotal.toFixed(2)})\n\n` +
        `📥 Download CSV: <a href="${blobMetadata.url}">Click here</a>\n\n` +
        `🔍 Updated: ${updateTime}`
    );
  } catch (error) {
    console.error("Critical Blob/Gemini Error:", error);

    // Check if it's a Gemini API error
    if (
      error.message.includes("503") ||
      error.message.includes("overloaded") ||
      error.message.includes("UNAVAILABLE")
    ) {
      ctx.reply(
        "🚫 The AI service is temporarily overloaded. Please try again in a few minutes. " +
          "This is a temporary issue with Google's servers."
      );
    } else if (
      error.message.includes("rate limit") ||
      error.message.includes("429")
    ) {
      ctx.reply(
        "⏳ Rate limit exceeded. Please wait a moment before sending another expense."
      );
    } else if (error.message.includes("Blob")) {
      ctx.reply(
        "💾 There was an issue saving your data. Please try again or contact support."
      );
    } else {
      ctx.reply(
        "❌ An unexpected error occurred. Please try again later. " +
          "If the problem persists, please contact support."
      );
    }
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
