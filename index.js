import express from "express";
import { MongoClient, ObjectId } from "mongodb";
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

app.get("/seller-products", async (_req, res) => {
    try {
        const products = await sellerProducts
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).json({ products });
    } catch (err) {
        console.error("Failed to fetch products:", err);
        return res.status(500).json({ message: "Failed to fetch products." });
    }
});

app.get("/seller-products/:sellerId", async (req, res) => {
    const sellerId = req.params.sellerId?.trim();

    if (!sellerId) {
        return res.status(400).json({ message: "sellerId is required." });
    }

    try {
        const products = await sellerProducts
            .find({ sellerId })
            .sort({ createdAt: -1 })
            .toArray();

        return res.status(200).json({ products });
    } catch (err) {
        console.error("Failed to fetch seller products:", err);
        return res.status(500).json({ message: "Failed to fetch seller products." });
    }
});

app.delete("/seller-products/:productId", async (req, res) => {
    const productId = req.params.productId;
    const sellerId = typeof req.query.sellerId === "string" ? req.query.sellerId.trim() : "";

    if (!ObjectId.isValid(productId)) {
        return res.status(400).json({ message: "A valid productId is required." });
    }

    if (!sellerId) {
        return res.status(400).json({ message: "sellerId is required." });
    }

    try {
        const result = await sellerProducts.deleteOne({
            _id: new ObjectId(productId),
            sellerId,
        });

        if (!result.deletedCount) {
            return res.status(404).json({ message: "Product not found." });
        }

        return res.status(200).json({ message: "Seller product deleted successfully." });
    } catch (err) {
        console.error("Failed to delete seller product:", err);
        return res.status(500).json({ message: "Failed to delete seller product." });
    }
});

app.patch("/seller-products/:productId", async (req, res) => {
    const productId = req.params.productId;
    const { sellerId, _id, createdAt, updatedAt, status, ...updates } = req.body ?? {};

    if (!ObjectId.isValid(productId)) {
        return res.status(400).json({ message: "A valid productId is required." });
    }

    if (typeof sellerId !== "string" || !sellerId.trim()) {
        return res.status(400).json({ message: "sellerId is required." });
    }

    if (!Object.keys(updates).length) {
        return res.status(400).json({ message: "Provide at least one product field to update." });
    }

    try {
        const result = await sellerProducts.findOneAndUpdate(
            { _id: new ObjectId(productId), sellerId: sellerId.trim() },
            { $set: { ...updates, updatedAt: new Date() } },
            { returnDocument: "after" },
        );

        if (!result) {
            return res.status(404).json({ message: "Product not found." });
        }

        return res.status(200).json({ product: result });
    } catch (err) {
        console.error("Failed to update seller product:", err);
        return res.status(500).json({ message: "Failed to update seller product." });
    }
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});
