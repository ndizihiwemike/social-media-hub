// server.js
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(cors());

// --------------------------------------------------
// 1. MongoDB connection
// --------------------------------------------------
mongoose
  .connect("mongodb://localhost:27017/connecthub")
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.error("DB ERROR:", err));

// --------------------------------------------------
// 2. Configure Multer for File Uploads
// --------------------------------------------------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image and video files are allowed!'), false);
  }
};

const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

// Serve static files from uploads directory
app.use('/uploads', express.static('uploads'));

// --------------------------------------------------
// 3. Schemas & Models - All collections for ConnectHub
// --------------------------------------------------

// Users collection
const userSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  fullName: { type: String, default: "" },
  profilePicture: { type: String, default: "" },
  bio: { type: String, default: "" },
  isOnline: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now }
}, {
  timestamps: true
});

userSchema.pre("save", async function (next) {
  if (this.isModified("password")) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});

const User = mongoose.model("User", userSchema);

// Posts collection
const postSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  content: { type: String, required: true },
  media: [{
    type: { type: String, enum: ['image', 'video'] },
    url: String,
    caption: String,
    filename: String
  }],
  location: {
    name: String,
    coordinates: [Number]
  },
  mood: String,
  visibility: { type: String, enum: ['public', 'friends', 'private'], default: 'public' },
  hashtags: [String],
  likes: [String], // Array of user IDs who liked
}, {
  timestamps: true
});

const Post = mongoose.model("Post", postSchema);

// Followers collection
const followerSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  followerId: { type: String, required: true },
  followedId: { type: String, required: true }
}, {
  timestamps: true
});

followerSchema.index({ followerId: 1, followedId: 1 }, { unique: true });
const Follower = mongoose.model("Follower", followerSchema);

// Comments collection
const commentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  postId: { type: String, required: true },
  userId: { type: String, required: true },
  content: { type: String, required: true },
  likes: [String], // Array of user IDs who liked the comment
  parentCommentId: { type: String, default: null } // For nested comments
}, {
  timestamps: true
});

const Comment = mongoose.model("Comment", commentSchema);

// Stories collection
const storySchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  media: {
    type: { type: String, enum: ['image', 'video'] },
    url: String,
    filename: String
  },
  caption: String,
  views: [String], // Array of user IDs who viewed
  expiresAt: { type: Date, required: true }
}, {
  timestamps: true
});

const Story = mongoose.model("Story", storySchema);

// Likes collection
const likeSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  targetId: { type: String, required: true },
  targetType: { type: String, enum: ['post', 'comment'], required: true }
}, {
  timestamps: true
});

likeSchema.index({ userId: 1, targetId: 1, targetType: 1 }, { unique: true });
const Like = mongoose.model("Like", likeSchema);

// Notifications collection
const notificationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  type: { type: String, enum: ['like', 'comment', 'follow', 'mention'], required: true },
  sourceUserId: { type: String, required: true },
  targetId: { type: String, required: true },
  message: { type: String, required: true },
  isRead: { type: Boolean, default: false }
}, {
  timestamps: true
});

const Notification = mongoose.model("Notification", notificationSchema);

// Feedback collection
const feedbackSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  comment: { type: String, required: true }
}, {
  timestamps: true
});

const Feedback = mongoose.model("Feedback", feedbackSchema);

// --------------------------------------------------
// 4. UTILITY FUNCTIONS
// --------------------------------------------------
const generateId = () => {
  return Math.random().toString(36).substr(2, 9);
};

const populateUserFields = async (users) => {
  const usersWithCounts = await Promise.all(
    users.map(async (user) => {
      const [followersCount, followingCount, postsCount] = await Promise.all([
        Follower.countDocuments({ followedId: user.id }),
        Follower.countDocuments({ followerId: user.id }),
        Post.countDocuments({ userId: user.id })
      ]);
      
      return {
        ...user.toObject(),
        followersCount,
        followingCount,
        postsCount
      };
    })
  );
  return usersWithCounts;
};

// Clean up files if post creation fails
const cleanupFiles = (files) => {
  if (files && files.length > 0) {
    files.forEach(file => {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    });
  }
};

// --------------------------------------------------
// 5. AUTHENTICATION & USER ROUTES
// --------------------------------------------------

// Login endpoint
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    
    // Update user as online
    await User.findOneAndUpdate(
      { id: user.id },
      { isOnline: true, lastSeen: new Date() }
    );
    
    res.json({ 
      id: user.id,
      username: user.username, 
      email: user.email,
      fullName: user.fullName,
      profilePicture: user.profilePicture,
      bio: user.bio
    });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// Register endpoint
app.post("/users", async (req, res) => {
  try {
    const { username, email, password, fullName } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ error: "Username, email and password are required" });
    }
    
    const user = await User.create({ 
      id: generateId(),
      username, 
      email, 
      password,
      fullName: fullName || username
    });
    
    res.status(201).json({ 
      id: user.id,
      username: user.username, 
      email: user.email,
      fullName: user.fullName
    });
  } catch (e) { 
    res.status(400).json({ error: e.message }); 
  }
});

app.get("/users", async (req, res) => {
  try {
    const users = await User.find().select("-password");
    const usersWithCounts = await populateUserFields(users);
    res.json(usersWithCounts);
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

app.get("/users/:id", async (req, res) => {
  try {
    const user = await User.findOne({ id: req.params.id }).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    
    const [followersCount, followingCount, postsCount] = await Promise.all([
      Follower.countDocuments({ followedId: user.id }),
      Follower.countDocuments({ followerId: user.id }),
      Post.countDocuments({ userId: user.id })
    ]);
    
    const userWithCounts = {
      ...user.toObject(),
      followersCount,
      followingCount,
      postsCount
    };
    
    res.json(userWithCounts);
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

app.put("/users/:id", async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.password) {
      updates.password = await bcrypt.hash(updates.password, 10);
    }
    
    const user = await User.findOneAndUpdate(
      { id: req.params.id }, 
      updates, 
      {
        new: true,
        runValidators: true,
      }
    ).select("-password");
    
    if (!user) return res.status(404).json({ error: "User not found" });
    
    res.json(user);
  } catch (e) { 
    res.status(400).json({ error: e.message }); 
  }
});

app.delete("/users/:id", async (req, res) => {
  try {
    const user = await User.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Delete all user data
    await Promise.all([
      Post.deleteMany({ userId: req.params.id }),
      Comment.deleteMany({ userId: req.params.id }),
      Story.deleteMany({ userId: req.params.id }),
      Like.deleteMany({ userId: req.params.id }),
      Notification.deleteMany({ 
        $or: [
          { userId: req.params.id }, 
          { sourceUserId: req.params.id }
        ] 
      }),
      Follower.deleteMany({ 
        $or: [
          { followerId: req.params.id }, 
          { followedId: req.params.id }
        ] 
      }),
      User.findOneAndDelete({ id: req.params.id })
    ]);
    
    res.json({ msg: "User and all associated data deleted successfully" });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// --------------------------------------------------
// 6. POSTS ROUTES with File Upload
// --------------------------------------------------
app.post("/posts", upload.array('media', 5), async (req, res) => {
  try {
    const { userId, content, visibility = 'public', location, mood, hashtags } = req.body;
    
    if (!userId || (!content && (!req.files || req.files.length === 0))) {
      cleanupFiles(req.files);
      return res.status(400).json({ error: "User ID and either content or media are required" });
    }
    
    // Check if user exists
    const user = await User.findOne({ id: userId });
    if (!user) {
      cleanupFiles(req.files);
      return res.status(404).json({ error: "User not found" });
    }
    
    // Process uploaded files
    const media = [];
    if (req.files && req.files.length > 0) {
      req.files.forEach(file => {
        media.push({
          type: file.mimetype.startsWith('image/') ? 'image' : 'video',
          url: `${req.protocol}://${req.get('host')}/uploads/${file.filename}`,
          caption: file.originalname,
          filename: file.filename
        });
      });
    }
    
    // Process hashtags if provided
    let hashtagsArray = [];
    if (hashtags) {
      if (typeof hashtags === 'string') {
        hashtagsArray = hashtags.split(',').map(tag => tag.trim().replace('#', ''));
      } else if (Array.isArray(hashtags)) {
        hashtagsArray = hashtags;
      }
    }
    
    // Process location if provided
    let locationObj = {};
    if (location) {
      try {
        locationObj = typeof location === 'string' ? JSON.parse(location) : location;
      } catch (e) {
        locationObj = { name: location };
      }
    }
    
    const post = await Post.create({ 
      id: generateId(),
      userId, 
      content: content || '',
      visibility,
      media: media,
      location: locationObj,
      mood: mood || '',
      hashtags: hashtagsArray
    });
    
    // Populate post with user data for response
    const postWithUser = {
      ...post.toObject(),
      username: user.username
    };
    
    res.status(201).json(postWithUser);
  } catch (e) { 
    cleanupFiles(req.files);
    res.status(400).json({ error: e.message }); 
  }
});

app.get("/posts", async (req, res) => {
  try {
    const { userId } = req.query;
    let query = {};
    
    if (userId) {
      query.userId = userId;
    }
    
    const posts = await Post.find(query).sort({ createdAt: -1 }).lean();
    
    // Get user details and comments for each post
    const postsWithDetails = await Promise.all(
      posts.map(async (post) => {
        const [user, comments, likesCount] = await Promise.all([
          User.findOne({ id: post.userId }).select('username'),
          Comment.find({ postId: post.id }).sort({ createdAt: -1 }).limit(10),
          Like.countDocuments({ targetId: post.id, targetType: 'post' })
        ]);
        
        // Get user details for each comment
        const commentsWithUsers = await Promise.all(
          comments.map(async (comment) => {
            const commentUser = await User.findOne({ id: comment.userId }).select('username');
            return {
              ...comment.toObject(),
              username: commentUser ? commentUser.username : 'Unknown User'
            };
          })
        );
        
        return {
          ...post,
          username: user ? user.username : 'Unknown User',
          comments: commentsWithUsers,
          likesCount,
          // Add this for frontend compatibility
          likes: post.likes || []
        };
      })
    );
    
    res.json(postsWithDetails);
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

app.get("/posts/:id", async (req, res) => {
  try {
    const post = await Post.findOne({ id: req.params.id });
    if (!post) return res.status(404).json({ error: "Post not found" });
    
    const [user, comments, likesCount] = await Promise.all([
      User.findOne({ id: post.userId }).select('username'),
      Comment.find({ postId: post.id }).sort({ createdAt: -1 }),
      Like.countDocuments({ targetId: post.id, targetType: 'post' })
    ]);
    
    const commentsWithUsers = await Promise.all(
      comments.map(async (comment) => {
        const commentUser = await User.findOne({ id: comment.userId }).select('username');
        return {
          ...comment.toObject(),
          username: commentUser ? commentUser.username : 'Unknown User'
        };
      })
    );
    
    const postWithDetails = {
      ...post.toObject(),
      username: user ? user.username : 'Unknown User',
      comments: commentsWithUsers,
      likesCount
    };
    
    res.json(postWithDetails);
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

app.put("/posts/:id", upload.array('media', 5), async (req, res) => {
  try {
    const { content, visibility, location, mood, hashtags } = req.body;
    
    const post = await Post.findOne({ id: req.params.id });
    if (!post) {
      cleanupFiles(req.files);
      return res.status(404).json({ error: "Post not found" });
    }
    
    const updates = {};
    if (content !== undefined) updates.content = content;
    if (visibility !== undefined) updates.visibility = visibility;
    if (location !== undefined) {
      try {
        updates.location = typeof location === 'string' ? JSON.parse(location) : location;
      } catch (e) {
        updates.location = { name: location };
      }
    }
    if (mood !== undefined) updates.mood = mood;
    if (hashtags !== undefined) {
      if (typeof hashtags === 'string') {
        updates.hashtags = hashtags.split(',').map(tag => tag.trim().replace('#', ''));
      } else if (Array.isArray(hashtags)) {
        updates.hashtags = hashtags;
      }
    }
    
    // Process new uploaded files
    if (req.files && req.files.length > 0) {
      const newMedia = req.files.map(file => ({
        type: file.mimetype.startsWith('image/') ? 'image' : 'video',
        url: `${req.protocol}://${req.get('host')}/uploads/${file.filename}`,
        caption: file.originalname,
        filename: file.filename
      }));
      updates.media = [...post.media, ...newMedia];
    }
    
    const updatedPost = await Post.findOneAndUpdate(
      { id: req.params.id }, 
      updates, 
      { 
        new: true, 
        runValidators: true 
      }
    );
    
    res.json(updatedPost);
  } catch (e) { 
    cleanupFiles(req.files);
    res.status(400).json({ error: e.message }); 
  }
});

app.delete("/posts/:id", async (req, res) => {
  try {
    const post = await Post.findOne({ id: req.params.id });
    if (!post) return res.status(404).json({ error: "Post not found" });

    // Delete associated media files
    if (post.media && post.media.length > 0) {
      post.media.forEach(media => {
        const filePath = path.join('uploads', media.filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      });
    }

    await Promise.all([
      Post.findOneAndDelete({ id: req.params.id }),
      Comment.deleteMany({ postId: req.params.id }),
      Like.deleteMany({ targetId: req.params.id, targetType: 'post' })
    ]);
    
    res.json({ msg: "Post and all associated data deleted successfully" });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// Standalone media upload endpoint
app.post("/upload/media", upload.array('media', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }
    
    const media = req.files.map(file => ({
      type: file.mimetype.startsWith('image/') ? 'image' : 'video',
      url: `${req.protocol}://${req.get('host')}/uploads/${file.filename}`,
      caption: file.originalname,
      filename: file.filename
    }));
    
    res.json({ 
      success: true,
      media,
      message: `Successfully uploaded ${media.length} file(s)`
    });
  } catch (e) {
    cleanupFiles(req.files);
    res.status(500).json({ error: e.message });
  }
});

// Delete media from post
app.delete("/posts/:postId/media/:filename", async (req, res) => {
  try {
    const { postId, filename } = req.params;
    
    const post = await Post.findOne({ id: postId });
    if (!post) return res.status(404).json({ error: "Post not found" });
    
    // Remove media from post
    post.media = post.media.filter(media => media.filename !== filename);
    await post.save();
    
    // Delete file from server
    const filePath = path.join('uploads', filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    res.json({ msg: "Media deleted successfully", post });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------
// 7. FOLLOWERS ROUTES
// --------------------------------------------------
app.post("/followers", async (req, res) => {
  try {
    const { followerId, followedId } = req.body;
    
    if (!followerId || !followedId) {
      return res.status(400).json({ error: "Follower ID and Followed ID are required" });
    }
    
    if (followerId === followedId) {
      return res.status(400).json({ error: "Cannot follow yourself" });
    }
    
    // Check if users exist
    const [follower, followed] = await Promise.all([
      User.findOne({ id: followerId }),
      User.findOne({ id: followedId })
    ]);
    
    if (!follower || !followed) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Check if already following
    const existingFollow = await Follower.findOne({ followerId, followedId });
    if (existingFollow) {
      return res.status(400).json({ error: "Already following this user" });
    }
    
    const follow = await Follower.create({ 
      id: generateId(),
      followerId, 
      followedId 
    });
    
    // Create notification
    await Notification.create({
      id: generateId(),
      userId: followedId,
      type: 'follow',
      sourceUserId: followerId,
      targetId: followedId,
      message: `${follower.username} started following you`
    });
    
    res.status(201).json({ 
      msg: "Followed successfully",
      follow 
    });
  } catch (e) { 
    res.status(400).json({ error: e.message }); 
  }
});

app.delete("/followers", async (req, res) => {
  try {
    const { followerId, followedId } = req.body;
    
    if (!followerId || !followedId) {
      return res.status(400).json({ error: "Follower ID and Followed ID are required" });
    }
    
    const result = await Follower.deleteOne({ followerId, followedId });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Follow relationship not found" });
    }
    
    res.json({ msg: "Unfollowed successfully" });
  } catch (e) { 
    res.status(400).json({ error: e.message }); 
  }
});

app.get("/followers/:userId", async (req, res) => {
  try {
    const followers = await Follower.find({ followedId: req.params.userId });
    
    const followersWithUsernames = await Promise.all(
      followers.map(async (follower) => {
        const user = await User.findOne({ id: follower.followerId }).select('username profilePicture');
        return {
          ...follower.toObject(),
          username: user ? user.username : 'Unknown User',
          profilePicture: user ? user.profilePicture : ''
        };
      })
    );
    
    res.json(followersWithUsernames);
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

app.get("/following/:userId", async (req, res) => {
  try {
    const following = await Follower.find({ followerId: req.params.userId });
    
    const followingWithUsernames = await Promise.all(
      following.map(async (follow) => {
        const user = await User.findOne({ id: follow.followedId }).select('username profilePicture');
        return {
          ...follow.toObject(),
          username: user ? user.username : 'Unknown User',
          profilePicture: user ? user.profilePicture : ''
        };
      })
    );
    
    res.json(followingWithUsernames);
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// --------------------------------------------------
// 8. COMMENTS ROUTES
// --------------------------------------------------
app.post("/comments", async (req, res) => {
  try {
    const { postId, userId, content, parentCommentId = null } = req.body;
    
    if (!postId || !userId || !content) {
      return res.status(400).json({ error: "Post ID, User ID, and content are required" });
    }
    
    // Check if post and user exist
    const [post, user] = await Promise.all([
      Post.findOne({ id: postId }),
      User.findOne({ id: userId })
    ]);
    
    if (!post) return res.status(404).json({ error: "Post not found" });
    if (!user) return res.status(404).json({ error: "User not found" });
    
    const comment = await Comment.create({ 
      id: generateId(),
      postId, 
      userId, 
      content,
      parentCommentId
    });
    
    // Create notification for post owner
    if (post.userId !== userId) {
      await Notification.create({
        id: generateId(),
        userId: post.userId,
        type: 'comment',
        sourceUserId: userId,
        targetId: postId,
        message: `${user.username} commented on your post`
      });
    }
    
    const commentWithUser = {
      ...comment.toObject(),
      username: user.username
    };
    
    res.status(201).json(commentWithUser);
  } catch (e) { 
    res.status(400).json({ error: e.message }); 
  }
});

app.get("/comments/post/:postId", async (req, res) => {
  try {
    const comments = await Comment.find({ postId: req.params.postId }).sort({ createdAt: -1 });
    
    const commentsWithUsers = await Promise.all(
      comments.map(async (comment) => {
        const user = await User.findOne({ id: comment.userId }).select('username profilePicture');
        return {
          ...comment.toObject(),
          username: user ? user.username : 'Unknown User',
          profilePicture: user ? user.profilePicture : ''
        };
      })
    );
    
    res.json(commentsWithUsers);
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

app.delete("/comments/:id", async (req, res) => {
  try {
    const comment = await Comment.findOne({ id: req.params.id });
    if (!comment) return res.status(404).json({ error: "Comment not found" });

    await Comment.findOneAndDelete({ id: req.params.id });
    res.json({ msg: "Comment deleted successfully" });
  } catch (e) { 
    res.status(400).json({ error: e.message }); 
  }
});

// --------------------------------------------------
// 9. STORIES ROUTES with File Upload
// --------------------------------------------------
app.post("/stories", upload.single('media'), async (req, res) => {
  try {
    const { userId, caption } = req.body;
    
    if (!userId || !req.file) {
      cleanupFiles([req.file]);
      return res.status(400).json({ error: "User ID and media are required" });
    }
    
    // Check if user exists
    const user = await User.findOne({ id: userId });
    if (!user) {
      cleanupFiles([req.file]);
      return res.status(404).json({ error: "User not found" });
    }
    
    const story = await Story.create({ 
      id: generateId(),
      userId, 
      media: {
        type: req.file.mimetype.startsWith('image/') ? 'image' : 'video',
        url: `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`,
        filename: req.file.filename
      },
      caption: caption || '',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours from now
    });
    
    const storyWithUser = {
      ...story.toObject(),
      username: user.username
    };
    
    res.status(201).json(storyWithUser);
  } catch (e) { 
    cleanupFiles([req.file]);
    res.status(400).json({ error: e.message }); 
  }
});

app.get("/stories", async (req, res) => {
  try {
    const stories = await Story.find({ expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .lean();
    
    const storiesWithUsers = await Promise.all(
      stories.map(async (story) => {
        const user = await User.findOne({ id: story.userId }).select('username');
        return {
          ...story,
          username: user ? user.username : 'Unknown User'
        };
      })
    );
    
    res.json(storiesWithUsers);
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

app.get("/stories/user/:userId", async (req, res) => {
  try {
    const stories = await Story.find({ 
      userId: req.params.userId,
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });
    
    res.json(stories);
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// --------------------------------------------------
// 10. LIKES ROUTES
// --------------------------------------------------
app.post("/likes", async (req, res) => {
  try {
    const { userId, targetId, targetType } = req.body;
    
    if (!userId || !targetId || !targetType) {
      return res.status(400).json({ error: "User ID, Target ID, and Target Type are required" });
    }
    
    // Check if like already exists
    const existingLike = await Like.findOne({ userId, targetId, targetType });
    if (existingLike) {
      return res.status(400).json({ error: "Already liked" });
    }
    
    const like = await Like.create({ 
      id: generateId(),
      userId, 
      targetId, 
      targetType 
    });
    
    // Create notification for like
    let targetOwnerId = null;
    if (targetType === 'post') {
      const post = await Post.findOne({ id: targetId });
      targetOwnerId = post ? post.userId : null;
    } else if (targetType === 'comment') {
      const comment = await Comment.findOne({ id: targetId });
      targetOwnerId = comment ? comment.userId : null;
    }
    
    if (targetOwnerId && targetOwnerId !== userId) {
      const user = await User.findOne({ id: userId }).select('username');
      await Notification.create({
        id: generateId(),
        userId: targetOwnerId,
        type: 'like',
        sourceUserId: userId,
        targetId: targetId,
        message: `${user.username} liked your ${targetType}`
      });
    }
    
    res.status(201).json(like);
  } catch (e) { 
    res.status(400).json({ error: e.message }); 
  }
});

app.delete("/likes", async (req, res) => {
  try {
    const { userId, targetId, targetType } = req.body;
    
    if (!userId || !targetId || !targetType) {
      return res.status(400).json({ error: "User ID, Target ID, and Target Type are required" });
    }
    
    const result = await Like.deleteOne({ userId, targetId, targetType });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Like not found" });
    }
    
    res.json({ msg: "Unliked successfully" });
  } catch (e) { 
    res.status(400).json({ error: e.message }); 
  }
});

app.get("/likes/count/:targetId/:targetType", async (req, res) => {
  try {
    const { targetId, targetType } = req.params;
    const count = await Like.countDocuments({ targetId, targetType });
    res.json({ count });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// --------------------------------------------------
// 11. NOTIFICATIONS ROUTES
// --------------------------------------------------
app.get("/notifications/user/:userId", async (req, res) => {
  try {
    const notifications = await Notification.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(50);
    
    const notificationsWithSource = await Promise.all(
      notifications.map(async (notification) => {
        const sourceUser = await User.findOne({ id: notification.sourceUserId }).select('username profilePicture');
        return {
          ...notification.toObject(),
          sourceUsername: sourceUser ? sourceUser.username : 'Unknown User',
          sourceProfilePicture: sourceUser ? sourceUser.profilePicture : ''
        };
      })
    );
    
    res.json(notificationsWithSource);
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

app.put("/notifications/:id/read", async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { id: req.params.id },
      { isRead: true },
      { new: true }
    );
    
    if (!notification) return res.status(404).json({ error: "Notification not found" });
    
    res.json(notification);
  } catch (e) { 
    res.status(400).json({ error: e.message }); 
  }
});

app.put("/notifications/user/:userId/read-all", async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.params.userId, isRead: false },
      { isRead: true }
    );
    
    res.json({ msg: "All notifications marked as read" });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// --------------------------------------------------
// 12. FEEDBACK ROUTES
// --------------------------------------------------
app.post("/feedback", async (req, res) => {
  try {
    const { name, comment } = req.body;
    
    if (!name || !comment) {
      return res.status(400).json({ error: "Name and comment are required" });
    }
    
    const feedback = await Feedback.create({ 
      id: generateId(),
      name, 
      comment 
    });
    
    res.status(201).json(feedback);
  } catch (e) { 
    res.status(400).json({ error: e.message }); 
  }
});

app.get("/feedback", async (req, res) => {
  try {
    const feedback = await Feedback.find().sort({ createdAt: -1 });
    res.json(feedback);
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

// --------------------------------------------------
// 13. HEALTH CHECK
// --------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    message: "ConnectHub Server is running",
    uploads: fs.existsSync('uploads') ? 'Available' : 'Not available'
  });
});

// Error handling for file uploads
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Too many files. Maximum is 5 files.' });
    }
  }
  res.status(500).json({ error: error.message });
});

// --------------------------------------------------
// 14. START SERVER
// --------------------------------------------------
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`ConnectHub Server running on http://localhost:${PORT}`);
  console.log(`File uploads directory: ${path.join(process.cwd(), 'uploads')}`);
});