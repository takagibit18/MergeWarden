from pkg.base import Base as Parent, Mixin, helper

class Child(Parent, Mixin):
    def __init__(self):
        helper()

def run():
    helper()
