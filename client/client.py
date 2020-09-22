import socket
from queue import Queue
from threading import Thread
import pygame
import cards
import math
import random
from screens import *
import time

pygame.init()
ip = "localhost"
ip = "10.0.2.15"
port = 8000
clientSocket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

def dec_cardstack(enc_message):
    enc_card_list = enc_message.split("#")
    card_list = []
    for card in enc_card_list:
        card_l = card.split(":")
        card_int = [int(code) for code in card_l]
        card_list.append(card_int)
    return card_list

def dec_activecard(enc_message):
    active_card = enc_message.split(":")
    return [int(code) for code in active_card]

def dec_score(enc_message):
    enc_score_list = enc_message.split("#")
    score_list = []
    for score in enc_score_list:
        score_list.append(score.split(":"))
    return score_list

def end(enc_message):
    print("game over, player {} win".format(enc_message))

def start():
    print("The game is being initialized")

images = []
size = 7

for i in range(1, size * size + (size + 2)):
    images.append(pygame.image.load("./client/images/im_ ({}).png".format(str(i))))
    images[-1] = pygame.transform.scale(images[-1], (150,150))

clientSocket.connect((ip, port))
print("connected")
active_card = None
personal_card = None
game = False
user = 0
timer = 0
go = False
lobby = True
score_list = []
angle = 0
delta = 2 * math.pi / (size)
input_queue = Queue(maxsize = 0)

def sock_recv(socket, queue):
    while True:
        msg = socket.recv(2048)
        queue.put(msg)

def recv_message(message):
    global cards_obj, active_card, go, angle, delta, personal_card, user, game, lobby, score_list, timer
    split_message = message.split("|")
    if split_message[0] == "CARDSTACK":
        cardlist = dec_cardstack(split_message[1])

        for card in cardlist:
            imageList = []
            posList = []
            posList.append([-75, -75])
            imageList.append(pygame.transform.rotate(images[card[0]], random.randint(0, 360)))
            for image_num in card[1:]:
                angle += delta
                posx = 225 * math.cos(angle) - 75 - 10
                posy = 225 * math.sin(angle) - 75 - 10
                posList.append((posx,posy))
                imageList.append(pygame.transform.rotate(images[image_num], random.randint(0, 360)))
            cards_obj.append(cards.Card(posList, imageList, card))
        personal_card = cards_obj.pop()
        personal_card.pos = [350, 350]
        personal_card.rect()

    elif split_message[0] == "ACTIVECARD":
        active_card = dec_activecard(split_message[1])
        imageList = []
        posList = []
        posList.append([-75, -75])
        imageList.append(pygame.transform.rotate(images[active_card[0]], random.randint(0, 360)))
        for image_num in active_card[1:]:
            angle += delta
            posx = 225 * math.cos(angle) - 75 - 10
            posy = 225 * math.sin(angle) - 75 - 10
            posList.append((posx,posy))
            imageList.append(pygame.transform.rotate(images[int(image_num)], random.randint(0, 360)))
        active_card = cards.Card(posList,imageList, active_card)
        active_card.pos = [1050, 350]
        active_card.rect()
        score_list = split_message[2].split(":")
        go = True

    elif split_message[0] == "END":
        end(split_message[1])
        game = False

    elif split_message[0] == "START":
        print("start")
        game = True
        lobby = False
    
    elif split_message[0] == "USERID":
        user = split_message[1]
    
    elif split_message[0] == "COUNTDOWN":
        timer = split_message[1]
        

def decode_message(msg):
    if "$" in msg:
        new_msg = msg.split("$")
        for msg_split in new_msg:
            recv_message(msg_split)
    else:    
        recv_message(msg)

def penalty(queue, t):
    for i in range(t, 0, -1):
        queue.put(i)
        time.sleep(1)
    queue.put(0)
cards_obj = []

Thread(target = sock_recv, args = [clientSocket,input_queue]).start()
screen = pygame.display.set_mode((1400, 700))



while True:
    ready_button = Button(screen, (350, 250), (700, 200), "Ready?", (250, 0, 0), (150, 150, 200), False, 180)
    penalty_queue = Queue(maxsize = 0)
    do_penalty = False
    ready_button.draw()
    pygame.display.update()
    countdown_start = False
    sent_ready = False
    while lobby:
        for event in pygame.event.get():

            if event.type == pygame.QUIT:
                clientSocket.send("QUIT|{}".format(str(user)).encode("utf-8"))
                clientSocket.close()
                pygame.quit() 
            
            ready_button.handle_event(event)

            if not countdown_start:
                if ready_button.active and not sent_ready:
                    clientSocket.send(("READY|{}".format(str(user))).encode("utf-8"))
                    sent_ready = True
                
                elif not ready_button.active and sent_ready:
                    clientSocket.send(("NOTREADY|{}".format(str(user))).encode("utf-8"))
                    sent_ready = False

                ready_button.draw()
                pygame.display.update()

        if not input_queue.empty():
            msg = input_queue.get().decode("utf-8")
            decode_message(msg)
            if timer == 0:
                ready_button.draw()
            else:
                countdown_start = True
                countdown(screen, (525, 175), (350, 350), timer)
            pygame.display.update()
        

    screen.fill((0,0,0))
    while game:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                clientSocket.send("QUIT|{}".format(str(user)).encode("utf-8"))
                clientSocket.close()
                pygame.quit()
            if event.type == pygame.MOUSEBUTTONDOWN:

                # clientSocket.send("CARDPLAYED|{}".format(str(user)).encode("utf-8")) #CHEAT CODE FOR FAST RUN ->> DEBUGGING
                
                pos = pygame.mouse.get_pos()
                image_id = personal_card.collide(pos)
                if image_id != None and not do_penalty:
                    if image_id in active_card.imageId:
                        active_card = personal_card
                        if len(cards_obj) > 0:
                            personal_card = cards_obj.pop()
                        active_card.pos = [1050,350]
                        active_card.rect()
                        personal_card.pos = [350,350]
                        personal_card.rect()
                        clientSocket.send("CARDPLAYED|{}".format(str(user)).encode("utf-8"))
                    else:
                        do_penalty = True
                        t = 3
                        Thread(target=penalty, args=[penalty_queue, t]).start()

        if not input_queue.empty():
            msg = input_queue.get().decode("utf-8")
            decode_message(msg)

        if go and not do_penalty:
            active_card.draw(screen)
            personal_card.draw(screen)

            
            scoreboard(screen, (575, 625), (250, 50), score_list, user)

            pygame.display.update()
            go = False

        if do_penalty:
            if not penalty_queue.empty():
                t = penalty_queue.get()
                countdown(screen, (0, 0), (1400, 700), t, True, 3)
                pygame.display.update()
                if t == 0:
                    do_penalty = False
                    go = True
                    screen.fill((0, 0, 0))
    print("gameEnd", user)
    screen.fill((0, 0, 0))
    scoreBoard(screen, (100, 50), (1200, 500), score_list, user)
    replay_button = Button(screen, (100, 575), (575, 100), "Again?", (250, 0, 0), (0, 0, 30), False, 80)
    quit_button = Button(screen, (725, 575), (575, 100), "Quit?", (250, 0, 0), (0, 0, 30), False, 80)
    replay_button.draw()
    quit_button.draw()
    pygame.display.update()
    replay = True
    while replay:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                clientSocket.send("QUIT|{}".format(str(user)).encode("utf-8"))
                clientSocket.close()
                pygame.quit()
            replay_button.handle_event(event)
            quit_button.handle_event(event)
        if replay_button.active:
            replay = False
        if quit_button.active:
            clientSocket.send("QUIT|{}".format(str(user)).encode("utf-8"))
            clientSocket.close()
            pygame.quit()
    screen.fill((0, 0, 0))
    active_card = None
    personal_card = None
    game = False
    timer = 0
    go = False
    lobby = True
    score_list = []
    print("replay")