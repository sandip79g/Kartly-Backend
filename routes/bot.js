const express = require("express");
const { Ollama } = require("ollama");
const db = require("../db");

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
    } else {
        throw new Error(`Tool ${toolName} not found.`);
    }
}

const systemPrompt = [{
    "role": "system",
    "content": `
    You are a helpful assistant for the e-commerce platform Kartly.

    Answer questions about products, orders, and general platform inquiries clearly and concisely.

    Use your best judgment and avoid unnecessary clarification questions. If the user's request can reasonably be handled with a tool, use the tool directly.

    You have access to a 'search_product' tool for searching products in the Kartly database.

    Rules:

    * Use 'search_product' when the user is looking for, asking about, or comparing products.
    * Infer reasonable search terms from the user's message instead of asking extra questions.
    * Do not invent product names, prices, availability, or specifications.
    * If the tool returns products, summarize the most relevant results for the user.
    * If the tool returns empty, null, or no matching products, tell the user that no products were found.
    * Never return an empty response after a tool call.
    * Do not repeatedly call the same tool with the same search.
    * Use previous conversation context when handling follow-up requests.

    Prefer:

    **Understand → Use tool if needed → Give answer**

    rather than:

    **Ask questions → Ask more questions → Use tool**

`
}]

router.post("/chat", async (req, res) => {
    const { messages, user_id } = req.body;

    if (!messages || messages.length === 0) {
        return res.status(400).json({
            message: "Messages are required."
        });
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
            model: "qwen3.5:4b",
            messages: chatMessages,
            thinking: false,
            tools: [
                {
                    type: "function",
                    function: {
                        name: "search_product",
                        description: "Search for products in the database based on a search text also called while searching the price.",
                        parameters: {
                            type: "object",
                            properties: {
                                searchText: {
                                    type: "string",
                                    description: "The text to search for in product names and descriptions."
                                }
                            },
                            required: ["searchText"]
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
                model: "qwen3.5:4b",
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

module.exports = router;