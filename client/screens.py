import pygame

pygame.init()

def text_objects(text, font, color = (255, 255, 255)):
    textSurface = font.render(text, True, color)
    return textSurface, textSurface.get_rect()

class Button:

    def __init__(self, screen, pos, size, text, active_color, passive_color, active, font_size):
        self.screen = screen
        self.pos = pos
        self.size = size
        self.text = text
        self.active_color = active_color
        self.passive_color = passive_color
        self.active = active
        self.rect = pygame.Rect(pos[0], pos[1], size[0], size[1])
        self.font_size = font_size

    def draw(self):
        pygame.draw.rect(self.screen, (self.active_color if self.active else self.passive_color), self.rect)
        pygame.draw.rect(self.screen, (255, 255, 255), self.rect, 1)
        TextSurf, TextRect = text_objects(self.text, pygame.font.Font('freesansbold.ttf', self.font_size))
        TextRect.center = ((self.pos[0] + self.size[0] // 2,self.pos[1] + self.size[1] // 2))
        self.screen.blit(TextSurf, TextRect)

    def handle_event(self,event):
        if event.type == pygame.MOUSEBUTTONDOWN:
            pos = event.pos
            if self.rect.collidepoint(pos):
                self.active = not self.active


def scoreboard(screen, pos, size, score, userId):
    num = len(score)
    place_per_user = size[0] // num
    pygame.draw.rect(screen,(0,0,0),pygame.Rect(pos[0], pos[1], size[0], size[1]), 0)
    pygame.draw.rect(screen,(255, 255, 255),pygame.Rect(pos[0], pos[1], size[0], size[1]), 1)
    for i in range(num):
        if i == int(userId):
            TextSurf, TextRect = text_objects(str(score[i]), pygame.font.Font('freesansbold.ttf', 36), (255, 0, 0))
        else:
            TextSurf, TextRect = text_objects(str(score[i]), pygame.font.Font('freesansbold.ttf', 36))
        
        posx = pos[0] + place_per_user * i + place_per_user // 2
        posy = pos[1] + size[1] // 2
        
        TextRect.center = ((posx, posy))
        screen.blit(TextSurf, TextRect)

def countdown(screen, pos, size, time, penalty = False, start_time = 5):
    time = int(time)
    screen.fill((time * 255 / start_time, 255 - time * 255 / start_time, 0) if penalty else (255 - time * 255 / start_time, 255 - time * 255 / start_time, 255 - time * 255 / start_time))
    posx = pos[0] + size[0] // 2
    posy = pos[1] + size[1] // 2
    TextSurf, TextRect = text_objects(str(time), pygame.font.Font('freesansbold.ttf', 115), (0, 0, 0) if penalty else (time * 255 / start_time, time * 255 / start_time, time * 255 / start_time))
    TextRect.center = ((posx, posy))
    screen.blit(TextSurf, TextRect)

def scoreBoard(screen, pos, size, score, userId):
    num = len(score)
    score = [int(score_str) for score_str in score]
    max_score = max(score)
    player_space = size[0] // num
    pygame.draw.rect(screen, (0, 0, 30), pygame.Rect(pos[0], pos[1], size[0], size[1]), 0)
    pygame.draw.rect(screen, (255, 255, 255), pygame.Rect(pos[0], pos[1], size[0], size[1]), 1)
    sizex = 2/3 * player_space
    for player in range(num):
        posx = pos[0] + 1/6 * player_space + player_space * player
        sizey = score[player] * 0.7 * size[1] / max_score
        posy = pos[1] + 0.8 * size[1] - sizey
        pygame.draw.rect(screen, (255 - 255 * score[player] // max_score, 255 * score[player] // max_score, 0), pygame.Rect(posx, posy, sizex, sizey), 0)
        TextSurf, TextRect = text_objects("Player " + str(player) + ": " + str(score[player]), pygame.font.Font('freesansbold.ttf', 36), (250, 0, 0) if userId == player else (255, 255, 255))
        TextRect.center = ((posx + 0.5 * sizex, pos[1] + 0.9 * size[1]))
        screen.blit(TextSurf, TextRect)
 