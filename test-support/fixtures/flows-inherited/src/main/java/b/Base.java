package b;
public abstract class Base {
  private Repo repo;
  public void publish(Order o) { repo.save(o); }
}
