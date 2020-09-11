import pygame

pygame.init()
class Card:
    def __init__(self,posList,imageList,imageId,pos=[0,0]):
        self.pos = pos
        self.imageId = imageId
        self.posList = posList
        self.imageList = imageList
        self.rectList = []

    def draw(self,screen):
        pygame.draw.circle(screen,(250,250,250),self.pos,350)
        for i in range(len(self.imageList)):
            screen.blit(self.imageList[i],(self.posList[i][0]+self.pos[0],self.posList[i][1]+self.pos[1]))
            # pygame.draw.rect(screen,(250,0,0),self.rectList[i],1)
        

    def __getItem__(self,index):
        return self.imageList[index]

    def collide(self,pos):
        for rect in self.rectList:
            print(rect,pos)
            if rect.collidepoint(pos):
                clicked_image = self.imageId[self.rectList.index(rect)]
                print("collided")
                return clicked_image

    def rect(self):
        self.rectList = [pygame.Rect(self.posList[i][0]+self.pos[0],self.posList[i][1]+self.pos[1],self.imageList[i].get_width(),self.imageList[i].get_height()) for i in range(len(self.imageList))]
        print(self.rectList)