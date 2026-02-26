const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

router.post('/register', userController.register);
router.get('/users', userController.getUsers);
router.get('/users/phone/:phone', userController.getUserByPhone);
router.patch('/users/:id', userController.updateUser);

module.exports = router;
