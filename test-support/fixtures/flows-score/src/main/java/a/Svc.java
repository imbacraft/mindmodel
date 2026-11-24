package a;
public class Svc {
  private Repo repo;
  private Quiet quiet;
  public void create(Order o) { repo.save(o); }
  public void read() { quiet.look(); }
}
