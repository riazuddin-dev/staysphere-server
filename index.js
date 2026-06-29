require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cookieParser = require("cookie-parser");

const app = express();

app.use(
  cors({
    origin: [
      "https://property-platfrom.vercel.app",
      "http://localhost:3000",
    ],
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

const client = new MongoClient(process.env.MONGO_DB, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("staysphere");
    
    const userCollection = db.collection("user");
    const propertyCollection = db.collection("properties");
    const bookingCollection = db.collection("bookings");
    const favoriteCollection = db.collection("favorites");
    const reviewCollection = db.collection("reviews");
    const transactionCollection = db.collection("transactions");
    const sessionCollection = db.collection("session");

    app.get("/", (req, res) => {
      res.send("StaySphere Server Running 🚀");
    });

    console.log("✅ MongoDB Connected");
  } catch (error) {
    console.log(error);
  }
}

run().catch(console.dir);

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});