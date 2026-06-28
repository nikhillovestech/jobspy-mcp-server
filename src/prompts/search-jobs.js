import { z } from "zod";

export function searchJobsPrompt(server) {
  server.prompt(
    "search-jobs",
    "Search for jobs based on keywords, location, and filters",
    {
      query: z.string().describe("Job title, skill, or keyword to search for"),
      location: z.string().optional().describe("City, state, or 'remote'"),
      job_type: z
        .enum(["fulltime", "parttime", "contract", "internship"])
        .optional()
        .describe("Employment type"),
      experience_level: z
        .enum(["entry", "mid", "senior", "lead"])
        .optional()
        .describe("Experience level required"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Number of results to return"),
    },
    async ({ query, location, job_type, experience_level, limit }) => {
      const parts = [`Find ${limit ?? 10} job listings for: "${query}"`];

      if (location) parts.push(`Location: ${location}`);
      if (job_type) parts.push(`Job type: ${job_type}`);
      if (experience_level) parts.push(`Experience level: ${experience_level}`);

      parts.push(
        "For each result include: job title, company, location, salary range if available, key requirements, and a brief description."
      );

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: parts.join("\n"),
            },
          },
        ],
      };
    }
  );
}
