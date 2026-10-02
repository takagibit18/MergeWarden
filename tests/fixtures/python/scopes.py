class LocalStore:
    def save(self, value):
        return value

class RemoteStore:
    def save(self, value):
        return value

def entry(store, value):
    return store.save(value)
