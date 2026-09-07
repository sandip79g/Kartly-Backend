const express = require("express");
const { Ollama } = require("ollama");
const db = require("../db");
const { searchKnowledge } = require("./rag");

const router = express.Router();

const ollama = new Ollama();


const searchProduct = async (searchText) => {
    const query = `
        SELECT p.*, c.name AS category
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.title LIKE ? OR p.description LIKE ? or c.name LIKE ?
    `;
    const params = [`%${searchText}%`, `%${searchText}%`, `%${searchText}%`];
    return db.prepare(query).all(...params);
};


const callTool = async (toolName, parameters, userId=null) => {
    if (toolName === "search_product") {
        const { searchText } = parameters;
        return await searchProduct(searchText);
    } else if (toolName === "search_knowledge") {
        const { query, limit } = parameters;
        const response = await searchKnowledge({ query, limit });
        return JSON.stringify(response);
    } else {
        throw new Error(`Tool ${toolName} not found.`);
    }
}

const systemPrompt = [
    {
        role: "system",
        content: `
You are Kartly AI, the customer assistant for the e-commerce platform Kartly.

Your job is to help users with products, orders, customer support, and questions about Kartly.

You have access to tools that contain the real and current information for Kartly.

TOOL ROUTING RULES

1. PRODUCT QUESTIONS
If the user wants to:
- find a product
- search for products
- compare products
- ask about prices
- ask about product availability
- ask about product specifications
- request recommendations

you MUST use the "search_product" tool.

Examples:
"Show me headphones under £100"
"Do you have running shoes?"
"Which laptop is better?"
"Find me a cheap Bluetooth speaker"

→ use search_product


2. KARTLY POLICY AND CUSTOMER SUPPORT QUESTIONS
If the user asks about:
- customer support
- returns
- refunds
- delivery or shipping
- cancellations
- payment policies
- privacy
- warranties
- complaints
- terms and conditions
- account support
- other Kartly-specific rules or information

you MUST use the "search_knowledge" tool BEFORE answering.

Examples:
"Can I return my order?"
"How long does a refund take?"
"What is your customer support policy?"
"Can I cancel an order?"
"What happens if my product arrives damaged?"

→ use search_knowledge

Never answer Kartly-specific policies from your own general knowledge.
Search the knowledge base first.


3. ORDER QUESTIONS
If an order-related tool is available, use it when the user asks about their
specific order, delivery status, cancellation, or payment status.


4. GENERAL CONVERSATION
For greetings, casual conversation, and general questions that do not require
Kartly-specific information, answer normally without using a tool.

Examples:
"Hello"
"How are you?"
"Thanks"

→ answer normally.


TOOL BEHAVIOUR

- Use tools without asking unnecessary clarification questions.
- Infer reasonable search terms from the user's message.
- Do not invent products, prices, stock, specifications, policies, or order information.
- If a tool returns relevant results, use those results to answer the user.
- If search_product returns no products, clearly say that no matching products were found.
- If search_knowledge returns no relevant information, clearly say that the requested information could not be found in the Kartly knowledge base.
- Never produce an empty response after a tool call.
- Never pretend that you called a tool when you did not.
- Do not repeatedly call the same tool with the same query.
- Use previous conversation messages to understand follow-up questions.

For tool queries, rewrite the user's request into a short useful search query when appropriate.

Preferred workflow:

Understand request
→ Decide whether a tool is required
→ Call the appropriate tool
→ Read the tool result
→ Answer the user

Do not ask unnecessary questions before using an appropriate tool.
        `
    }
];

router.post("/chat", async (req, res) => {
    const { messages, user_id, model_name } = req.body;

    if (!messages || messages.length === 0) {
        return res.status(400).json({
            message: "Messages are required."
        });
    }

    if (!model_name) {
        model_name = "qwen3.5:0.8b";
    }

    try {
        const chatMessages = [
            ...systemPrompt,
            ...messages.map(msg => ({
                role: msg.role,
                content: msg.content
            }))
        ];

            if (user_id) {
                const lastMessage = messages[messages.length - 1];

                db.prepare("INSERT INTO chat_history (user_id, role, message) VALUES (?, ?, ?)").run(
                    user_id,
                    lastMessage.role,
                    lastMessage.content
                );
            }

        let response = await ollama.chat({
            model: model_name,
            messages: chatMessages,
            think: false,
            tools: [
                {
                    type: "function",
    function: {
        name: "search_knowledge",

        description: `
        Search Kartly's internal knowledge base.

        Use this tool whenever the user asks about Kartly-specific information
        that cannot be safely answered from general knowledge, including:

        - customer support
        - return policy
        - refund policy
        - shipping and delivery policy
        - cancellations
        - payment policy
        - privacy policy
        - terms and conditions
        - warranty
        - account support
        - complaints
        - store rules
        - FAQs

        Always search the knowledge base before answering these questions.
        Do not invent Kartly policies.
        `,

        parameters: {
            type: "object",

            properties: {
                query: {
                    type: "string",
                    description:
                        "A concise semantic search query based on the user's question."
                },

                limit: {
                    type: "integer",
                    description:
                        "Maximum number of matching knowledge chunks to return."
                }
            },

            required: ["query"]
        }
    }
                }
            ],
            stream: false
        });

        console.dir(response, { depth: null });

        // Check whether the model requested a tool
        if (response.message.tool_calls?.length) {

            const toolCall = response.message.tool_calls[0];

            const name = toolCall.function.name;
            const parameters = toolCall.function.arguments;

            console.log("Tool:", name);
            console.log("Parameters:", parameters);

            // Execute the tool
            const toolResponse = await callTool(
                name,
                parameters,
                user_id
            );

            console.log("Tool response:", toolResponse);

            // Add the assistant's tool-call message
            chatMessages.push(response.message);

            // Add the result of the tool
            chatMessages.push({
                role: "tool",
                content: JSON.stringify(toolResponse)
            });

            // Ask Ollama to produce the final answer
            response = await ollama.chat({
                model: model_name,
                messages: chatMessages,
                stream: false
            });

            console.log("Final response:", response);
        }

        if (user_id) {
            db.prepare("INSERT INTO chat_history (user_id, role, message) VALUES (?, ?, ?)").run(
                user_id,
                "assistant",
                response.message.content
            );
        }

        return res.status(200).json({
            role: "assistant",
            message: response.message.content
        });

    } catch (error) {
        console.error("Error in Ollama chat:", error);

        return res.status(500).json({
            message: "Error processing the chat request."
        });
    }
});


router.get("/history/:userId", (req, res) => {
    const { userId } = req.params;

    try {
        const history = db.prepare(
            "SELECT role, message, created_at FROM chat_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
        ).all(userId);

        return res.status(200).json({ history: [...history].reverse() });
    } catch (error) {
        console.error("Error fetching chat history:", error);
        return res.status(500).json({
            message: "Error fetching chat history."
        });
    }
});

router.delete("/history", (req, res) => {
    // const { userId } = req.params;

    try {
        // db.prepare("DELETE FROM chat_history WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM chat_history").run(); // Delete all chat history for testing purposes
        return res.status(200).json({ message: "Chat history deleted." });
    } catch (error) {
        console.error("Error deleting chat history:", error);
        return res.status(500).json({
            message: "Error deleting chat history."
        });
    }
});

module.exports = router;