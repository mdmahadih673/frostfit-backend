import express from "express";
import { MongoClient } from "mongodb";
import cors from "cors";
import 'dotenv/config'


const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URL);

export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("frostfit");
const users = database.collection("user");
const sellerProducts = database.collection("sellerProducts");



app.get("/", (_req, res) => {
    res.send("Hello World!");
});

app.post("/seller-products", async (req, res) => {
    const productDetails = req.body;

    if (!productDetails || typeof productDetails !== "object" || Array.isArray(productDetails)) {
        return res.status(400).json({ message: "Request body must be a product object." });
    }

    if (typeof productDetails.sellerId !== "string" || !productDetails.sellerId.trim()) {
        return res.status(400).json({ message: "sellerId is required." });
    }

    const newProduct = {
        ...productDetails,
        sellerId: productDetails.sellerId.trim(),
        createdAt: new Date(),
    };
    delete newProduct._id;

    try {
        const result = await sellerProducts.insertOne(newProduct);
        return res.status(201).json({
            message: "Seller product created successfully.",
            product: { ...newProduct, _id: result.insertedId },
        });
    } catch (err) {
        console.error("Failed to create seller product:", err);
        return res.status(500).json({ message: "Failed to create seller product." });
    }
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});
