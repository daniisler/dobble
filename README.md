# Description of the Game

Dobble is a card game that you can play on your computer with this program. If you let it run, two cards appear on your screen. The one on the right is the same for all players. The one on the left is different for everybody. On each card there are eight images and every pair of cards has one image that matches. To play, you have to click on the specific image on the left card, which matches with one image on the card on the right side. If you succeed, the card you put shows up for every player. If you select a wrong image, you get penalized with a three-second timeout. The goal is to loose the whole card-stack as fast as possible. The player who finishes first wins the game.

# Installation

To install the game, you have to download the repository and have Python 3 and pygame installed on your computer.

To pull the git, run the following command in your terminal:

```
git clone https://github.com/daniisler/dobble.git
```

To install the pygame, run the following command in your terminal:

```
pip install pygame
```

# Start the game

One computer has to host the server. But that doesn't restrict from taking part as a client at the same time. To run the server, run the following command in your terminal:

```
python3 server/server.py
```

Each player can run the game on their own computer, which has to be in the same network as the server. The local IP address of the server has to be entered in the file `client/client.py` (line 14).

To run the game, symply run the following command in your terminal:

```
python3 client/client.py
```

# Play the game

To play the game, run the program as described in the previous section. Each user has to login with a username and password. You can also register a new user. When logged in, you can press the button 'Ready' and once all connected players are ready, the game starts. The first player to reach 20 points wins the game.

# Customization

You can add your custom images to the game. To do so, you have to add them to the folder `client/images`. The images have to be in the format `.png` and have to be named `im_(1).png`, `im_(2).png`, ... . It's funny to play the game with some images of your friends or family.

# Room for improvement

The whole user management system could be improved a lot. This was the first time the authors set up something in that regard. The idea behind it was to then present statistics about the players, but this was not implemented yet. If you wish to contribute to this project, feel free to do so. We are happy for improvements.