package demo;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@RequestMapping("/inherited")
public abstract class Base {

  @GetMapping("/list")
  public String list() {
    return "";
  }

  @GetMapping("/save")
  public String save() {
    return "";
  }

  @GetMapping("/remove")
  public String remove() {
    return "";
  }
}
