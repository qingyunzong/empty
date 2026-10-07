// Demo program for the effect checker.
global db
global log

fn fetch(q):
    read db
    call record(q)

fn record(x):
    write log

fn spin():
    read db
    call spin()

fn faulty():
    region tmp
    read tmp
    return tmp
