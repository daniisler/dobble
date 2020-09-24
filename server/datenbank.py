import sqlite3 as sql

class DB:
    def __init__(self, name=None):
        
        self.conn = None
        self.cursor = None

        if name:
            self.open(name)

    def addTable(self,table_name,column_names):
        try:
            self.cursor.execute("CREATE TABLE " + table_name + "({})".format(column_names))
        except:
            print("table already exists")

    def open(self,name):
        
        try:
            self.conn = sql.connect(name);
            self.cursor = self.conn.cursor()

        except sql.Error as e:
            print("Error connecting to database!")

    def close(self):
        
        if self.conn:
            self.conn.commit()
            self.cursor.close()
            self.conn.close()

    def __exit__(self,exc_type,exc_value,traceback):
        
        self.close()

    def write(self,table,columns,data):
        query = "INSERT INTO {0} VALUES ({2});".format(table,columns,data)
        print(query)
        self.cursor.execute(query)
        self.conn.commit()
        
    def querry(self,sql):
        self.cursor.execute(sql)
        return (self.cursor.fetchall())

    def print(self,table_name):
        for row in self.cursor.execute('SELECT * FROM '+ table_name):
            print(row)

        
# dobble_db = DB()
# dobble_db.open("DOBBLE")
# # dobble_db.addTable("users","id, ipv4, user_name")
# # dobble_db.write("users","id, ipv4, user_name","'5', 'name4', 'figa7'")

# print(dobble_db.querry("SELECT * FROM users WHERE id == '5'"))
# dobble_db.print("users")




    # def get(self,table,columns,limit=None):

    #     query = "SELECT {0} from {1};".format(columns,table)
    #     self.cursor.execute(query)

    #     # fetch data
    #     rows = self.cursor.fetchall()

    #     return rows[len(rows)-limit if limit else 0:]

    # def create_table(self,table_name,column_names):
    #     self.table_name = table_name
    #     cursor = self.c.cursor() 

    #     try:
    #         cursor.execute("CREATE TABLE " + table_name + " (" + ", ".join(column_names) + ")")
    #     except:
    #         print("table already exists!")
    
    # def print(self):
    #     for row in self.c.execute('SELECT * FROM '+self.table_name):
    #         print(row)


    # def inser_data(self,table_name,data): 
    #     cursor = self.c.cursor()
    #     string = "INSERT INTO "+table_name+" VALUES ("+"?" + ",?"*(len(data)-1)+")"
    #     cursor.execute(string, data)
    #     self.c.commit()

    # def querry(self,statement,data):
    #     cursor = self.c.cursor()
    #     cursor.execute(statement,data)
    #     return cursor.fetchall()